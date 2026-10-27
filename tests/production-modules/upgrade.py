"""Real Chromium old-production -> modular-production upgrade, local services only."""
import argparse
import hashlib
import http.server
import importlib.util
import json
import mimetypes
import re
import subprocess
import threading
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2]
module=importlib.util.spec_from_file_location('test_upgrade',ROOT/'tests/pwa/update-browser.py')
fixture=importlib.util.module_from_spec(module);module.loader.exec_module(fixture)
BASE='8b0bd65b3c94d2d51e8e611bc9644800ddd58291'
old=subprocess.check_output(['git','show',BASE+':index.html'],cwd=ROOT).decode()
for lib in ['app','auth','firestore']:
    old=old.replace('https://www.gstatic.com/firebasejs/10.8.0/firebase-'+lib+'-compat.js','./app/vendor/firebase-'+lib+'-compat-10.8.0.js')
old=old.replace('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js','./app/vendor/html2pdf-0.10.1.bundle.min.js')
old=re.sub(r"@import url\('https://fonts.googleapis.com/[^']+'\);","@import url('./app/vendor/caveat.css');",old)
phase={'new':False}
manifest=json.loads((ROOT/'app/build-manifest.json').read_text())

def demo(data):
    source=data.decode().replace('samosval-test',fixture.PROJECT)
    source=re.sub(r'const firebaseConfig\s*=\s*\{[\s\S]*?\};','const firebaseConfig = '+json.dumps(fixture.CONFIG)+';',source)
    return source.encode()

def asset(name):
    if name in ['','index.html']:
        return demo((ROOT/'index.html').read_bytes() if phase['new'] else old.encode())
    data=(ROOT/name).read_bytes()
    if name.startswith('app/build/') and name.endswith('.js'):return demo(data)
    return data

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        name=urlsplit(self.path).path.removeprefix('/Samosval/')
        if name=='sw.js':
            records=[{**r,'sha256':hashlib.sha256(asset(r['url'].removeprefix('./'))).hexdigest()} for r in manifest['assets']]
            data=re.sub(r'^const RECORDS = .*;$',lambda m:'const RECORDS = '+json.dumps(records)+';',(ROOT/'sw.js').read_text(),flags=re.M).encode()
        elif name in ['','index.html','manifest.json','icon.svg'] or name.startswith(('app/build/','app/vendor/')):
            try:data=asset(name)
            except (FileNotFoundError,IsADirectoryError):self.send_error(404);return
        else:self.send_error(404);return
        self.send_response(200)
        self.send_header('Content-Type',mimetypes.guess_type(name or 'index.html')[0] or 'application/octet-stream')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Security-Policy',fixture.CSP)
        self.end_headers();self.wfile.write(data)
    def log_message(self,*args):pass

args=argparse.ArgumentParser();args.add_argument('--chromium',required=True);args=args.parse_args()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
origin='http://127.0.0.1:'+str(server.server_port)
errors=[]
out=ROOT/'test-results/production-upgrade';out.mkdir(parents=True,exist_ok=True)
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.chromium,headless=True,chromium_sandbox=True)
        context=browser.new_context(service_workers='allow')
        context.expose_binding('__upgradeReport',lambda source,value:errors.append(value))
        context.add_init_script(fixture.FIXTURE)
        context.route('**/*',lambda route:route.continue_() if route.request.url.startswith(origin+'/') else route.abort())
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(origin+'/Samosval/index.html');fixture.wait_for_page_state(page,'window.__upgradeFixture?.authSettled')
        assert page.locator('.version-text').first.text_content()=='Версия 3.4.11'
        saved=page.evaluate('''async () => {
          currentUid='upgrade-user';currentEmail='upgrade@example.test';
          const queue=offlineJournalKey(), rows=JSON.stringify([{id:'pending-existing',status:'pending',type:'load',truckId:'saved-truck'}]);
          localStorage.setItem(queue,rows);localStorage.setItem('dt_settings',JSON.stringify({hapticLoad:false,cycleMinutes:25}));
          localStorage.setItem('dt_max_queue',JSON.stringify([{id:'saved-max',text:'retained'}]));
          const cache=await caches.open('samosval-test-shell-upgrade-sentinel');await cache.put('/keep-test',new Response('keep'));
          await new Promise((resolve,reject)=>{const r=indexedDB.open('production-upgrade-sentinel',1);r.onupgradeneeded=()=>r.result.createObjectStore('keep');r.onsuccess=()=>{const db=r.result,tx=db.transaction('keep','readwrite');tx.objectStore('keep').put('retained','queue');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=reject};});
          return {queue,rows,settings:localStorage.getItem('dt_settings'),max:localStorage.getItem('dt_max_queue')};
        }''')
        phase['new']=True
        page.evaluate("navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'})")
        fixture.wait_for_page_state(page,'navigator.serviceWorker.controller !== null')
        assert page.locator('.version-text').first.text_content()=='Версия 3.4.11','Do not reload an open shift automatically'
        page.reload();fixture.wait_for_page_state(page,'window.__upgradeFixture?.authSettled && window.AppPWA?.snapshot().shellReady')
        assert page.locator('.version-text').first.text_content()=='Версия 3.4.13'
        assert page.locator('#nav-timesheet,#tab-timesheet,script[id^="timesheet"]').count()==0
        for key in ['queue','dt_settings','dt_max_queue']:
            target=saved['queue'] if key=='queue' else key
            value=saved['rows'] if key=='queue' else saved['settings' if key=='dt_settings' else 'max']
            assert page.evaluate('(key)=>localStorage.getItem(key)',target)==value
        assert page.evaluate('settings.hapticLoad') is False
        assert page.evaluate("caches.has('samosval-test-shell-upgrade-sentinel')")
        assert page.evaluate('''() => new Promise(resolve=>{const r=indexedDB.open('production-upgrade-sentinel');r.onsuccess=()=>{const db=r.result,tx=db.transaction('keep');const q=tx.objectStore('keep').get('queue');q.onsuccess=()=>{resolve(q.result);db.close()}}})''')=='retained'
        context.set_offline(True);page.reload();fixture.wait_for_page_state(page,'window.__upgradeFixture?.authSettled && window.AppPWA?.snapshot().shellReady')
        assert page.locator('.version-text').first.text_content()=='Версия 3.4.13'
        page.goto(origin+'/Samosval/');fixture.wait_for_page_state(page,'window.AppPWA?.snapshot().shellReady')
        assert page.locator('.version-text').first.text_content()=='Версия 3.4.13','Installed start_url must open offline'
        page.screenshot(path=str(out/'offline-production.png'),full_page=True)
        assert not errors,errors
        browser.close()
    print('PASS production upgrade: real 3.4.11 -> modular 3.4.13; no forced reload; settings, pending queue, MAX queue, real IndexedDB and test cache retained; index and installed root open offline; no Timesheet')
finally:
    (out/'report.json').write_text(json.dumps({'errors':errors,'build':manifest['version']},indent=2))
    server.shutdown();server.server_close();thread.join(timeout=5)
