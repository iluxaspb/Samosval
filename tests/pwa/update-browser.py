#!/usr/bin/env python3
"""Real Chromium upgrade test; no live Firebase requests.
Usage: python tests/pwa/update-browser.py --old-dir /path/to/old/pages/artifact
Requires Python playwright and Chromium. Old directory: an earlier Pages artifact.
"""
import argparse, http.server, json, threading
from pathlib import Path
from urllib.parse import urlsplit, unquote
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--old-dir', type=Path, required=True)
parser.add_argument('--chromium', default=None)
args = parser.parse_args()
ROOT = Path(__file__).resolve().parents[2]
OLD = args.old_dir.resolve()
old_version = json.loads((OLD/'test-app/build-manifest.json').read_text())['version']
new_version = json.loads((ROOT/'test-app/build-manifest.json').read_text())['version']
assert old_version != new_version
phase = {'new': False, 'corrupt': False}
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw): super().__init__(*a, directory=str(ROOT), **kw)
    def translate_path(self, path):
        name = unquote(urlsplit(path).path).removeprefix('/Samosval/').lstrip('/')
        base = ROOT if phase['new'] or name == 'update-test.html' else OLD
        p = (base/name).resolve()
        return str(p if p.is_relative_to(base) else base/'not-found')
    def do_GET(self):
        if phase['corrupt'] and urlsplit(self.path).path.endswith('/index-test.html'):
            self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(b'wrong release');return
        return super().do_GET()
    def end_headers(self):
        self.send_header('Cache-Control','no-store');super().end_headers()
    def log_message(self, *_): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1',0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/Samosval/'
errors=[]
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
        context.route('**/*', lambda route: route.continue_() if urlsplit(route.request.url).hostname=='127.0.0.1' else route.abort())
        context.on('page', lambda p: p.on('pageerror', lambda error: errors.append(str(error))))
        page = context.new_page();page.goto(base+'index-test.html')
        page.wait_for_function('!!navigator.serviceWorker.controller && window.TestPWA?.snapshot().shellReady', timeout=40000)
        print('OLD header:', page.locator('.version-text').inner_text())
        assert page.locator('#admin-camera-button').count()==1, 'Real old build must have camera control'
        journal_key = 'samosval_offline_v1_samosval-offline_main_workspace_qa-update'
        queue = [{'id':f'op-{i}','shiftId':'qa-shift','truckId':'qa-truck','type':['arrive','load','ttn','reset'][i%4],'status':'pending','createdAt':i+1} for i in range(24)]
        expected = json.dumps(queue,ensure_ascii=False,separators=(',',':'))
        page.evaluate('''async data=>{
          localStorage.setItem(data.key,data.value);
          localStorage.setItem('qa-production-sentinel','keep-production');
          await new Promise((resolve,reject)=>{
            const r=indexedDB.open('qa-upgrade-preservation',1);
            r.onupgradeneeded=()=>r.result.createObjectStore('values');
            r.onerror=()=>reject(r.error);
            r.onsuccess=()=>{const db=r.result,tx=db.transaction('values','readwrite');tx.objectStore('values').put('keep-indexeddb','sentinel');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};
          });
          const c=await caches.open('qa-production-cache');await c.put('/qa-production-sentinel',new Response('keep-production-cache'));
        }''', {'key':journal_key,'value':expected})
        phase['new']=True
        page.goto(base+'index-test.html?release=3.1.18')
        page.wait_for_function('!!window.TestPWA')
        assert page.locator('#admin-camera-button').count()==1
        print('PASS reproduction: ordinary refresh/query still serves old camera-enabled build')
        helper=context.new_page();helper.goto(base+'update-test.html')
        helper.wait_for_selector('#state[data-state="waiting"]',timeout=45000)
        assert helper.locator('#open').is_hidden()
        assert new_version in helper.locator('#build').inner_text()
        assert old_version in helper.locator('#build').inner_text()
        assert helper.locator('#close-hint').is_visible()
        assert page.evaluate('(key)=>localStorage.getItem(key)',journal_key)==expected
        assert page.locator('#admin-camera-button').count()==1
        print('PASS updater detects waiting release and does not force-reload active operator')
        page.close()
        helper.wait_for_selector('#state[data-state="ready"]',timeout=30000)
        assert helper.locator('#open').is_enabled()
        assert helper.evaluate('(key)=>localStorage.getItem(key)',journal_key)==expected
        value = helper.evaluate('''()=>new Promise((resolve,reject)=>{const r=indexedDB.open('qa-upgrade-preservation');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,q=db.transaction('values').objectStore('values').get('sentinel');q.onsuccess=()=>{db.close();resolve(q.result);};};})''')
        assert value=='keep-indexeddb'
        assert helper.evaluate("localStorage.getItem('qa-production-sentinel')")=='keep-production'
        assert helper.evaluate("(async()=>{const c=await caches.open('qa-production-cache');return(await c.match('/qa-production-sentinel')).text();})()")=='keep-production-cache'
        print('PASS new build activates; 24 queued entries, IndexedDB and production sentinels survive')
        helper.locator('#open').click();helper.wait_for_url('**/index-test.html')
        helper.wait_for_function('!!window.TestPWA')
        assert helper.locator('.version-text').inner_text()=='Версия 3.1.18 · тест'
        assert helper.locator('#admin-camera-button').count()==0
        assert helper.locator('[id^="geo-photo"], [id^="object-photos"], [id^="local-photos"]').count()==0
        scripts=helper.locator('script[src]').evaluate_all('(els)=>els.map(e=>e.src)')
        assert not any(s for s in scripts if any(x in s for x in ['firebase-storage','geo-photo','object-photos','local-photos','photo-files']))
        assert helper.locator('#game-reward-load').input_value()=='1'
        assert helper.locator('#game-reward-arrive').input_value()=='2'
        assert helper.locator('#game-reward-ttn').input_value()=='0'
        helper.locator('.version-text').evaluate('(e)=>e.click()')
        assert helper.locator('#releaseHistoryDialog h3').first.inner_text().startswith('3.1.18')
        helper.evaluate("document.getElementById('releaseHistoryDialog').close()")
        print('PASS actual page: header/history 3.1.18, no camera/photo uploader/Storage SDK, three coin settings')
        context.set_offline(True)
        helper.reload();helper.wait_for_function('!!window.TestPWA')
        assert helper.locator('.version-text').inner_text()=='Версия 3.1.18 · тест'
        assert helper.locator('#admin-camera-button').count()==0
        assert helper.evaluate('(key)=>localStorage.getItem(key)',journal_key)==expected
        print('PASS offline reload uses new camera-free release and retains the queue')
        context.set_offline(False)
        phase['corrupt']=True
        helper.goto(base+'update-test.html')
        helper.wait_for_selector('#state[data-state="error"]',timeout=30000)
        assert 'не совпадает' in helper.locator('#state').inner_text()
        assert helper.locator('#open').is_hidden()
        assert helper.evaluate('(key)=>localStorage.getItem(key)',journal_key)==expected
        phase['corrupt']=False
        helper.locator('#retry').click();helper.wait_for_selector('#state[data-state="ready"]',timeout=30000)
        print('PASS mixed deployment is rejected; retry recovers without deleting data')
        fresh=browser.new_context(viewport={'width':390,'height':844})
        fresh.route('**/*', lambda route: route.continue_() if urlsplit(route.request.url).hostname=='127.0.0.1' else route.abort())
        clean=fresh.new_page();clean.goto(base+'update-test.html');clean.wait_for_selector('#state[data-state="ready"]',timeout=45000)
        print('PASS first install directly through the updater')
        Path('test-results').mkdir(exist_ok=True)
        clean.screenshot(path='test-results/test-updater-verified.png',full_page=True)
        print('PAGE_ERRORS:', json.dumps(errors,ensure_ascii=False))
        assert errors==[],errors
        browser.close()
finally:
    server.shutdown();server.server_close()
