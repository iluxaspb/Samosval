#!/usr/bin/env python3
"""Sandbox-required Chromium upgrade acceptance; all services are local fixtures.

The old directory must be the unchanged artifact from the pinned pre-update commit.
Auth is explicitly signed out; role checks below use synthetic UI permissions, not
real authentication/Firestore authorization. Worker/cache/IndexedDB are real.
"""
import argparse
import hashlib
import http.server
import json
import mimetypes
import re
import threading
import time
import traceback
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
PROJECT = 'demo-samosval-upgrade-audit'
CONFIG = {'projectId': PROJECT, 'apiKey': 'local-demo-not-a-credential',
          'appId': 'local-demo-app', 'authDomain': '127.0.0.1',
          'storageBucket': PROJECT + '.invalid'}
BASELINE_COMMIT = 'bd0e906e15a6cafb8b3dd7fd390d0fbc584218a7'
BASELINE_BUILD = '01915a70c2b10014'
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "font-src 'self' data:; connect-src 'self'; worker-src 'self'; "
       "media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'")


def wait_for_page_state(page, predicate, timeout=30000):
    """Poll via protocol evaluation, never repeated in-page eval under CSP.

    Playwright's string wait_for_function re-evaluates the string from a timer;
    strict script-src correctly rejects that timer eval if the first poll is false.
    Keep CSP intact and poll the unchanged condition from the test process instead.
    """
    deadline = time.monotonic() + timeout / 1000
    while True:
        if page.evaluate(predicate):
            return
        if time.monotonic() >= deadline:
            raise TimeoutError('Page state not reached: ' + predicate)
        page.wait_for_timeout(100)

# Runs before the app; only Auth and forbidden Storage are stubs. Real Firestore
# persistence is retained, but its network is disabled using the SDK API before
# app/background listeners or synthetic roles can start service traffic.
# This is NOT the Firestore-emulator/domain-action suite in full-audit/browser-run.
FIXTURE = r'''() => {
  window.__upgradeFixture = {ready:false, authSettled:false, networkDisabled:false, storageCalls:0,
    kind:'Signed-out local Auth stub; real Firestore persistence with SDK network disabled; synthetic role UI only'};
  const report = value => window.__upgradeReport(value);
  window.addEventListener('unhandledrejection', e => report({kind:'unhandledrejection', message:String(e.reason?.stack || e.reason)}));
  document.addEventListener('securitypolicyviolation', e => report({kind:'csp', message:e.violatedDirective + ': ' + e.blockedURI}));
  document.addEventListener('load', event => {
    if (event.target.tagName !== 'SCRIPT' || !event.target.src.includes('html2pdf-')) return;
    if (window.__upgradeFixture.ready) throw Error('Duplicate upgrade fixture');
    const sdk = window.firebase, initialize = sdk.initializeApp.bind(sdk);
    const deny = () => { throw Error('Auth service is unavailable in the signed-out upgrade fixture'); };
    const auth = {currentUser:null, signInWithEmailAndPassword:deny, createUserWithEmailAndPassword:deny,
      onAuthStateChanged(callback) { let active=true; setTimeout(async () => {
        if (active) { await callback(null); window.__upgradeFixture.authSettled=true; }
      }, 0); return () => {active=false;}; }, signOut:async () => {}};
    const storage = {setMaxUploadRetryTime(){},setMaxOperationRetryTime(){},ref(){
      window.__upgradeFixture.storageCalls++; throw Error('Storage prohibited in upgrade fixture');}};
    sdk.auth = Object.assign(() => auth, sdk.auth);
    sdk.storage = Object.assign(() => storage, sdk.storage);
    sdk.initializeApp = function(config, name) {
      if (config.projectId !== 'demo-samosval-upgrade-audit' || config.apiKey !== 'local-demo-not-a-credential') throw Error('Non-demo Firebase config');
      const app = initialize(config,name), firestore=app.firestore();
      // Settings alone do not start the SDK, so real persistence can still open.
      const settings=firestore.settings.bind(firestore);
      firestore.settings=options=>settings({...options,host:'127.0.0.1:9',ssl:false});
      firestore.settings({});
      if (!name || name==='[DEFAULT]') {
        const persistence=firestore.enablePersistence.bind(firestore);
        firestore.enablePersistence=(...args)=>{
          // Queue real persistence first, then SDK offline mode synchronously;
          // never start networking to an inert host and rely on CSP to stop it.
          const persisted=persistence(...args), disabled=firestore.disableNetwork();
          return Promise.all([persisted,disabled]).then(([result])=>{
            window.__upgradeFixture.networkDisabled=true; return result;
          });
        };
      } else {
        firestore.disableNetwork().catch(error=>report({kind:'fixture-network-disable',message:String(error)}));
      }
      app.auth=()=>auth; app.storage=()=>storage; return app;
    };
    window.__upgradeFixture.ready=true;
  }, true);
}'''


class Release:
    def __init__(self, directory):
        self.root = directory.resolve()
        self.manifest = json.loads((self.root / 'test-app/build-manifest.json').read_text())
        self.build = self.manifest['version']
        assert re.fullmatch(r'[a-f0-9]{16}', self.build), 'Invalid build identity'
        html = (self.root / 'index-test.html').read_text()
        label = re.search(r'<(?:span|button)\b[^>]*class="version-text"[^>]*>([^<]+)', html)
        assert label, 'Missing release label in generated HTML'
        self.label = label[1].strip()
        self.version = self.label.removeprefix('Версия ')
        # The pinned historical artifact genuinely had divergent labels: HTML
        # says 3.1.17, but its history module hardcodes runtime header 3.1.16.
        # Preserve that input, derive its runtime expectation from actual bytes,
        # and require the current release to agree with current HTML below.
        self.runtime_label = self.label
        assert any(mode in self.manifest['channel'] for mode in ['standalone', 'modular'])
        # Verify actual input artifacts before the local deployment-config rewrite.
        for record in self.manifest['assets']:
            assert self.digest(self.raw(record['url'])) == record['sha256'], record['url']
        worker = self.raw('sw-test.js').decode()
        assert re.search(r"const VERSION = ['\"]" + self.build + r"['\"]", worker)
        records = re.search(r'^const RECORDS = (\[.*\]);$', worker, re.M)
        assert records and json.loads(records[1]) == self.manifest['assets'], 'Input worker/manifest mismatch'
        self.records = [{**r, 'sha256': self.digest(self.asset(r['url']))} for r in self.manifest['assets']]

    @staticmethod
    def digest(data):
        return hashlib.sha256(data).hexdigest()

    def raw(self, name):
        file = (self.root / name.removeprefix('./')).resolve()
        assert file.is_relative_to(self.root) and file != self.root, 'Unsafe release asset path'
        return file.read_bytes()

    def asset(self, name):
        data = self.raw(name)
        if name.removeprefix('./') == 'index-test.html' or (name.removeprefix('./').startswith(('test-app/build/', 'test-app/src/', 'test-app/tabel/')) and name.endswith(('.js','.mjs'))):
            source = data.decode().replace('samosval-offline', PROJECT)
            if name.endswith('/core.js') or (name.endswith('index-test.html') and 'const firebaseConfig' in source):
                source, count = re.subn(r'const firebaseConfig\s*=\s*\{[\s\S]*?\};',
                    'const firebaseConfig = ' + json.dumps(CONFIG) + ';', source)
                assert count == 1, 'Expected one Firebase configuration'
                assert "const TEST_FIREBASE_PROJECT_ID = '" + PROJECT + "'" in source
            return source.encode()
        return data

    def served(self, name):
        if name == 'test-app/build-manifest.json':
            return json.dumps({**self.manifest, 'assets': self.records}).encode()
        if name == 'sw-test.js':
            return re.sub(r'^const RECORDS = \[.*\];$', 'const RECORDS = ' + json.dumps(self.records) + ';',
                          self.raw(name).decode(), flags=re.M).encode()
        return self.asset(name)


def make_server(old, new, phase, report):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.serve(False)

        def do_HEAD(self):
            self.serve(True)

        def serve(self, head):
            try:
                path = unquote(urlsplit(self.path).path)
                report['requests'].append(path)
                if not path.startswith('/Samosval/'):
                    self.send_error(404); return
                name = path.removeprefix('/Samosval/')
                allowed = (name in {'index-test.html', 'update-test.html', 'sw-test.js',
                                   'manifest-test.webmanifest', 'test-app/build-manifest.json'}
                           or name.startswith(('test-app/build/', 'test-app/src/', 'test-app/vendor/', 'test-app/icons/', 'test-app/tabel/', 'assets/')))
                if not allowed or '..' in Path(name).parts:
                    self.send_error(404); return
                if name == 'update-test.html':
                    content = (ROOT / name).read_bytes()
                elif phase['corrupt'] and name == 'index-test.html':
                    content = b'wrong release: intentional mixed-deployment fixture'
                else:
                    content = (new if phase['new'] else old).served(name)
                self.send_response(200)
                self.send_header('Content-Type', mimetypes.guess_type(name)[0] or 'application/octet-stream')
                self.send_header('Cache-Control', 'no-store')
                # CSP also applies to service workers, which may bypass routing.
                self.send_header('Content-Security-Policy', CSP)
                self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                if not head:
                    self.wfile.write(content)
            except FileNotFoundError:
                self.send_error(404)
            except Exception as error:
                report['errors'].append({'kind':'server', 'message':str(error)})
                self.send_error(500)

        def log_message(self, *_):
            pass

    return http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-dir', type=Path, required=True)
    parser.add_argument('--expected-old-build', default=BASELINE_BUILD)
    parser.add_argument('--chromium', default=None)
    parser.add_argument('--self-test', action='store_true', help='Validate input artifacts and isolated server, without a browser')
    args = parser.parse_args()
    old, new = Release(args.old_dir), Release(ROOT)
    assert old.build == args.expected_old_build, 'Wrong old artifact build; CI must fetch the pinned baseline'
    assert old.build != new.build, 'Old and new artifacts must differ'
    output = ROOT / 'test-results'
    output.mkdir(exist_ok=True)
    report = {'status':'running', 'baselineCommit':BASELINE_COMMIT,
              'oldBuild':old.build, 'newBuild':new.build, 'oldRelease':old.label, 'oldRuntimeRelease':old.runtime_label, 'newRelease':new.label,
              'browser':'Chromium, sandbox required', 'steps':[], 'errors':[], 'blockedRequests':[], 'requests':[],
              'fixtures':{'auth':'Signed-out local UI stub, no Auth service',
                'roleChecks':'Synthetic local permission variables with empty UID; not server authorization',
                'firestore':'Real SDK/persistence; SDK network disabled before application/background queries, inert demo configuration; no service',
                'queue':'24 synthetic pending journal entries, byte-for-byte retention; not replay verification',
                'source':'HTTP-only demo deployment identifiers and matching integrity manifests; repository artifacts unchanged'},
              'exclusions':['Real authentication', 'Domain queue replay', 'Live Firebase or MAX', 'Physical mobile/PWA installation']}
    phase = {'new':False, 'corrupt':False}
    server = make_server(old, new, phase, report)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    base = origin + '/Samosval/'
    browser = None
    playwright = None
    contexts = []

    def passed(name):
        report['steps'].append({'name':name, 'status':'passed'})
        print('PASS upgrade:', name, flush=True)

    def check_errors():
        assert report['errors'] == [], report['errors']
        assert report['blockedRequests'] == [], report['blockedRequests']

    try:
        if args.self_test:
            from urllib.request import urlopen
            class PollFixture:
                def __init__(self, values):
                    self.values = iter(values)
                    self.pauses = []

                def evaluate(self, predicate):
                    assert predicate.startswith('() => ')
                    value = next(self.values)
                    if isinstance(value, Exception):
                        raise value
                    return value

                def wait_for_timeout(self, milliseconds):
                    self.pauses.append(milliseconds)

            poll = PollFixture([False, False, True])
            wait_for_page_state(poll, '() => fixtureReady')
            assert poll.pauses == [100, 100], 'False first poll must not require in-page eval'
            try:
                wait_for_page_state(PollFixture([False]), '() => fixtureReady', timeout=0)
                raise AssertionError('A timed-out predicate must fail')
            except TimeoutError:
                pass
            try:
                wait_for_page_state(PollFixture([ValueError('fixture error')]), '() => fixtureReady')
                raise AssertionError('Evaluation errors must propagate')
            except ValueError as error:
                assert str(error) == 'fixture error'
            for is_new, release in [(False, old), (True, new)]:
                phase['new'] = is_new
                with urlopen(base + 'sw-test.js') as response:
                    assert response.headers['Content-Security-Policy'] == CSP
                    worker = response.read().decode()
                records = json.loads(re.search(r'^const RECORDS = (\[.*\]);$', worker, re.M)[1])
                assert records == release.records
                for record in records:
                    with urlopen(base + record['url'].removeprefix('./')) as response:
                        assert Release.digest(response.read()) == record['sha256'], record['url']
                with urlopen(base + 'test-app/build-manifest.json') as response:
                    assert json.load(response)['assets'] == records
            check_errors()
            passed('infrastructure only: original hashes plus rewritten local response/worker/manifest hashes')
            report['status'] = 'infrastructure-passed-browser-not-run'
            return

        from playwright.sync_api import sync_playwright
        playwright = sync_playwright().start()
        # A denied sandbox launch is a failed/unrun test, not a reason to weaken security.
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, chromium_sandbox=True)

        def context():
            ctx = browser.new_context(viewport={'width':390, 'height':844}, is_mobile=True, has_touch=True)
            contexts.append(ctx)
            ctx.tracing.start(screenshots=True, snapshots=True, sources=True)
            ctx.expose_binding('__upgradeReport', lambda source, value: report['errors'].append(value))
            ctx.add_init_script('(' + FIXTURE + ')()')

            def route_request(route):
                parsed = urlsplit(route.request.url)
                if (parsed.scheme == 'http' and parsed.netloc == urlsplit(origin).netloc
                        and parsed.username is None and parsed.password is None):
                    route.continue_()
                else:
                    report['blockedRequests'].append(route.request.url); route.abort('blockedbyclient')
            ctx.route('**/*', route_request)
            ctx.on('page', lambda p: p.on('pageerror', lambda error: report['errors'].append({'kind':'pageerror', 'message':str(error)})))
            return ctx

        def app_ready(p):
            wait_for_page_state(p, '() => window.__upgradeFixture?.ready && window.__upgradeFixture.authSettled && window.__upgradeFixture.networkDisabled && !!window.TestPWA')
            assert p.evaluate('window.__upgradeFixture.storageCalls') == 0
            assert p.evaluate('firebase.app().options.projectId') == PROJECT

        def release_checks(p):
            app_ready(p)
            assert p.locator('#mainHeader .version-text').text_content() == new.label
            assert p.locator('#admin-camera-button,[id^="geo-photo"],[id^="object-photos"],[id^="local-photos"]').count() == 0
            assert p.locator('[onclick^="toggleDrawMode"],[onclick^="clearDrawings"],[id^="draw-canvas"]').count() == 0
            scripts = p.locator('script[src]').evaluate_all('(els)=>els.map(e=>e.src)')
            assert not any(any(token in s for token in ['firebase-storage', 'geo-photo', 'object-photos', 'local-photos', 'photo-files']) for s in scripts)
            assert p.evaluate('window.TEST_APP_RELEASE.version') == new.version
            for action, value in [('load','1'), ('arrive','2'), ('ttn','0')]:
                assert p.locator('#game-reward-' + action).input_value() == value

        def old_release_checks(p):
            assert p.locator('#mainHeader .version-text').text_content() == old.runtime_label
            assert p.locator('meta[name="test-app-version"]').get_attribute('content') == old.version

        def role_checks(p):
            # This tests actual visibility and the real click handler using explicit
            # synthetic roles, never pretending to be authenticated to a service.
            p.evaluate("document.getElementById('authOverlay').style.display='none';document.getElementById('mainHeader').style.display='';document.querySelector('.container').style.display=''")
            p.evaluate("permissionsLoaded=true;currentUserRole='viewer';currentUserStatus='active';applyRoleUI()")
            assert p.locator('#mainHeader .version-text').is_hidden()
            p.locator('#mainHeader .version-text').evaluate('(e)=>e.click()')
            assert p.locator('#releaseHistoryDialog').count() == 0
            p.evaluate("currentUserRole='admin';applyRoleUI()")
            assert p.locator('#mainHeader .version-text').is_visible()
            assert p.locator('#mainHeader .version-text').evaluate('(e)=>getComputedStyle(e).color') == 'rgb(225, 29, 72)'
            p.locator('#mainHeader .version-text').click()
            p.locator('#releaseHistoryDialog[open]').wait_for(state='visible')
            assert p.locator('#releaseHistoryDialog h3').first.inner_text().startswith(new.version + ' — ')
            # Changing access closes a currently-open history, not just its launcher.
            p.evaluate("currentUserStatus='disabled';applyRoleUI()")
            p.locator('#releaseHistoryDialog').wait_for(state='detached')
            assert p.locator('#mainHeader .version-text').is_hidden()
            p.locator('#mainHeader .version-text').evaluate('(e)=>e.click()')
            assert p.locator('#releaseHistoryDialog').count() == 0
            p.evaluate("currentUserStatus='active';permissionsLoaded=false;applyRoleUI()")
            assert p.locator('#mainHeader .version-text').is_hidden()
            p.locator('#mainHeader .version-text').evaluate('(e)=>e.click()')
            assert p.locator('#releaseHistoryDialog').count() == 0
            p.evaluate("currentUserRole=null;currentUserStatus=null;applyRoleUI();document.getElementById('authOverlay').style.display='flex'")
            assert p.evaluate("!auth.currentUser && currentUid === ''"), 'Synthetic UI gate must never create a service identity'

        ctx = context()
        page = ctx.new_page(); page.goto(base + 'index-test.html'); app_ready(page)
        wait_for_page_state(page, '() => !!navigator.serviceWorker.controller && window.TestPWA.snapshot().activeVersion === '+json.dumps(old.build), timeout=45000)
        old_release_checks(page)
        journal_key = f'samosval_offline_v1_{PROJECT}_main_workspace_qa-update'
        queue = [{'id':f'op-{i}', 'shiftId':'qa-shift', 'truckId':'qa-truck',
                  'type':['arrive','load','ttn','reset'][i % 4], 'status':'pending', 'createdAt':i+1} for i in range(24)]
        expected = json.dumps(queue, ensure_ascii=False, separators=(',',':'))
        page.evaluate('''async data=>{
          localStorage.setItem(data.key,data.value); localStorage.setItem('qa-production-sentinel','keep-production');
          await new Promise((resolve,reject)=>{const r=indexedDB.open('qa-upgrade-preservation',1);
            r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onerror=()=>reject(r.error);
            r.onsuccess=()=>{const db=r.result,tx=db.transaction('values','readwrite');tx.objectStore('values').put('keep-indexeddb','sentinel');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
          const c=await caches.open('qa-production-cache');await c.put('/qa-production-sentinel',new Response('keep-production-cache'));
        }''', {'key':journal_key, 'value':expected})

        def retained(p):
            assert p.evaluate('(key)=>localStorage.getItem(key)', journal_key) == expected
            assert len(json.loads(p.evaluate('(key)=>localStorage.getItem(key)', journal_key))) == 24
            assert p.evaluate("localStorage.getItem('qa-production-sentinel')") == 'keep-production'
            assert p.evaluate("async()=>{const c=await caches.open('qa-production-cache');return(await c.match('/qa-production-sentinel')).text()}") == 'keep-production-cache'
            assert p.evaluate('''()=>new Promise((resolve,reject)=>{const r=indexedDB.open('qa-upgrade-preservation');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,q=db.transaction('values').objectStore('values').get('sentinel');q.onerror=()=>reject(q.error);q.onsuccess=()=>{db.close();resolve(q.result);};};})''') == 'keep-indexeddb'

        phase['new'] = True
        page.goto(base + 'index-test.html?release=' + new.build)
        app_ready(page)
        old_release_checks(page)
        retained(page)
        passed('ordinary refresh keeps cached old release and all queued trips')

        # The CURRENT recovery page has #repair/#status. It must refuse to
        # unregister a worker while unsynchronized trips are still queued.
        helper = ctx.new_page()
        helper.goto(base + 'update-test.html')
        assert helper.locator('#repair').is_visible()
        helper.locator('#repair').click()
        wait_for_page_state(helper,
            '() => document.querySelector("#status")?.textContent.includes("24 несинхронизированных")',
            timeout=10000)
        assert helper.url.startswith(base + 'update-test.html')
        retained(page)
        passed('recovery refuses pending offline trips without deleting or unregistering data')

        # A verified worker can download in the background, but the old page
        # retains control until it closes. No obsolete #state=waiting UI.
        wait_for_page_state(page,
            '() => window.TestPWA?.snapshot()?.waitingVersion === ' + json.dumps(new.build),
            timeout=45000)
        retained(page)
        passed('new worker installed and verified; old page remains open with intact queue')
        page.close()

        worker_ready = """async () => {
          const reg=await navigator.serviceWorker.getRegistration("./index-test.html");
          if(!reg?.active || reg.waiting)return false;
          return await new Promise(resolve=>{
            const ch=new MessageChannel(),t=setTimeout(()=>resolve(false),1500);
            ch.port1.onmessage=e=>{
              clearTimeout(t);ch.port1.close();ch.port2.close();
              resolve(e.data?.type==="TEST_PWA_STATUS" &&
                e.data?.version===EXPECTED_BUILD && e.data?.complete===true);
            };
            reg.active.postMessage({type:"TEST_PWA_STATUS"},[ch.port2]);
          });
        }""".replace("EXPECTED_BUILD",json.dumps(new.build))
        wait_for_page_state(helper, worker_ready, timeout=45000)
        helper.goto(base + 'index-test.html')
        release_checks(helper)
        role_checks(helper)
        retained(helper)
        passed('new release activated after old page closed; role gate and offline queue preserved')
        helper.screenshot(path=str(output / 'upgrade-new-release.png'), full_page=True)

        ctx.set_offline(True)
        helper.reload()
        release_checks(helper)
        retained(helper)
        passed('offline reload opens the new release with localStorage/IndexedDB/cache intact')
        ctx.set_offline(False)

        # Integrity mismatch is exercised in a NEW isolated context without a
        # pending queue. Never delete queued entries just to satisfy the test.
        phase['corrupt'] = True
        broken_ctx = context()
        broken = broken_ctx.new_page()
        broken.goto(base + 'update-test.html')
        broken.locator('#repair').click()
        wait_for_page_state(broken,
            '() => document.querySelector("#status")?.textContent.includes("не совпадают контрольные суммы")',
            timeout=10000)
        assert broken.url.startswith(base + 'update-test.html')
        passed('corrupt published HTML rejected by recovery before registration changes')

        phase['corrupt'] = False
        broken.on('dialog', lambda d: d.accept())
        broken.locator('#repair').click()
        broken.wait_for_url('**/index-test.html?repair=*', timeout=45000)
        release_checks(broken)
        role_checks(broken)
        passed('retry after valid publication reaches current release')

        clean_ctx = context()
        clean = clean_ctx.new_page()
        clean.on('dialog', lambda d: d.accept())
        clean.goto(base + 'update-test.html')
        clean.locator('#repair').click()
        clean.wait_for_url('**/index-test.html?repair=*', timeout=45000)
        release_checks(clean)
        role_checks(clean)
        passed('fresh installation via current recovery page opens correct release')
        clean.screenshot(path=str(output / 'test-updater-verified.png'), full_page=True)
        check_errors()
        for number, item in enumerate(contexts):
            item.tracing.stop(path=str(output / f'upgrade-trace-{number}.zip'))
            item.close()
        contexts.clear(); browser.close(); browser = None
        check_errors()
        report['status'] = 'passed'
    except Exception:
        report['status'] = 'failed'
        report['failure'] = traceback.format_exc()
        raise
    finally:
        # Cleanup/evidence happens on failed or denied sandbox launches as well.
        for number, item in enumerate(contexts):
            try:
                for p in item.pages:
                    p.screenshot(path=str(output / f'upgrade-failure-{number}-{len(report["requests"])}.png'), full_page=True)
                item.tracing.stop(path=str(output / f'upgrade-failure-trace-{number}.zip'))
                item.close()
            except Exception as error:
                report.setdefault('cleanupErrors', []).append(str(error))
        if browser:
            try:
                browser.close()
            except Exception as error:
                report.setdefault('cleanupErrors', []).append(str(error))
        if playwright:
            playwright.stop()
        server.shutdown(); server.server_close(); thread.join(timeout=5)
        (output / 'upgrade-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
