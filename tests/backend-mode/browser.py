"""Browser acceptance of the actual TEST header/settings and connection code.
No Firebase SDK, credentials, or external network requests are used.
"""
import argparse, http.server, re, threading
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--chromium',default=None);args=parser.parse_args()
    built=(ROOT/'index-test.html').read_text()
    styles='\n'.join(re.findall(r'<style\b[^>]*>[\s\S]*?</style>',built))
    header=re.search(r'<header id="mainHeader">[\s\S]*?</header>',built)[0]
    panel=re.search(r'<details class="admin-settings-group" id="admin-backend-settings"[\s\S]*?</details>',built)[0]
    fixture='''let currentUid='admin-a',currentEmail='qa@example.test',currentUserRole='admin',currentUserStatus='active',permissionsLoaded=true,initialized=true;
const firebaseConfig={projectId:'samosval-offline'},WORKSPACE_ID='main_workspace';
let queued=2,pendingOps=0,offlineServerUnreachable=false;
const syncState={errors:{},pendingWrites:{},docCount:{},lastSuccessAt:0,fromCache:{},everConnected:Object.fromEntries(['profile','permissions','trucks','status','shift'].map(k=>[k,true]))};
const offlinePendingCount=()=>queued,offlineUnreviewedFailures=()=>[];
const canAdmin=()=>currentUserRole==='admin'&&currentUserStatus==='active';
const showError=s=>{window.lastError=s},showToastEl=s=>{window.lastToast=s};
'''
    source=(ROOT/'test-app/source/core/03-formatting.js').read_text()+'\n'+(ROOT/'test-app/source/core/20-backend-mode.js').read_text()
    html='<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+styles+'<body data-release-admin="1" data-perms-ready="1">'+header+'<main style="padding:16px">'+panel+'</main><script>'+fixture+source+'\nupdateSyncUI();</script>'
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers();self.wfile.write(html.encode())
        def log_message(self,*args): pass
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=args.chromium,headless=True,chromium_sandbox=True)
            context=browser.new_context(viewport={'width':393,'height':852},is_mobile=True,has_touch=True)
            page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(f'http://127.0.0.1:{server.server_port}') else r.abort())
            page.goto(f'http://127.0.0.1:{server.server_port}/')
            out=ROOT/'test-results';out.mkdir(exist_ok=True)
            page.screenshot(path=str(out/'backend-mode-initial.png'),full_page=True)
            indicator=page.locator('#syncDot');select=page.locator('#testBackendMode')
            assert indicator.inner_text()=='F'
            assert select.input_value()=='firebase'
            assert page.locator('#syncBadge').inner_text()=='2'
            assert page.locator('#testBackendMode option[value="synology"]').is_disabled()
            select.select_option('auto');assert 'автоматически используется Firebase' in page.locator('#testBackendModeNote').inner_text()
            assert indicator.inner_text()=='F'
            page.reload();assert select.input_value()=='auto'
            page.evaluate("currentUid='admin-b';updateSyncUI()")
            assert select.input_value()=='firebase'
            page.evaluate("currentUid='admin-a';currentUserRole='viewer';updateSyncUI()")
            assert page.locator('#admin-backend-settings').is_hidden()
            assert page.evaluate("setTestBackendMode('firebase')") is False
            page.evaluate("currentUserRole='admin';updateSyncUI()")
            assert select.input_value()=='auto'
            assert page.evaluate("setTestBackendMode('synology')") is False
            assert select.input_value()=='auto' and indicator.inner_text()=='F'
            page.evaluate('offlineServerUnreachable=true;updateSyncUI()')
            assert indicator.inner_text()=='О'
            page.wait_for_function('getComputedStyle(document.querySelector("#syncDot")).backgroundColor==="rgb(100, 116, 139)"')
            assert page.evaluate('queued')==2
            page.evaluate('offlineServerUnreachable=false;updateSyncUI()')
            for width,height in [(320,740),(393,852),(915,412)]:
                page.set_viewport_size({'width':width,'height':height})
                page.screenshot(path=str(out/f'backend-mode-{width}.png'),full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),f'Horizontal overflow at {width}'
                box=indicator.bounding_box();assert 20<=box['width']<=28 and 20<=box['height']<=28
                assert page.locator('.sync-dot-wrap').get_attribute('aria-label').startswith('Firebase')
            page.set_viewport_size({'width':393,'height':852})
            out=ROOT/'test-results';out.mkdir(exist_ok=True)
            page.screenshot(path=str(out/'backend-mode-mobile.png'),full_page=True)
            assert not errors,errors
            browser.close()
            print('PASS browser: actual TEST F/О indicator and admin modes, pending queue preserved, account isolation, reload, role loss, blocked NAS, 320/393/915px layout')
    finally:
        server.shutdown();server.server_close();thread.join(timeout=5)
if __name__=='__main__':main()
