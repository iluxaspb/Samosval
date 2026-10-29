#!/usr/bin/env python3
"""Chromium mobile acceptance: formula guide, colored syntax and reference outlines."""
import argparse, http.server, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2]
def main():
    p=argparse.ArgumentParser()
    p.add_argument("--chromium",default=None)
    args=p.parse_args()
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self,*a,**kw):
            super().__init__(*a,directory=str(ROOT),**kw)
        def log_message(self,*a): pass
    server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with sync_playwright() as play:
            browser=play.chromium.launch(executable_path=args.chromium,headless=True,chromium_sandbox=True)
            try:
                context=browser.new_context(viewport={"width":393,"height":852},is_mobile=True,has_touch=True)
                page=context.new_page()
                failures=[]
                page.on("pageerror",lambda e: failures.append(str(e)))
                page.goto(f"http://127.0.0.1:{server.server_port}/tests/tabel-v2/harness.html")
                page.wait_for_function("() => window.ready===true")
                page.locator("#open").click()
                app=page.locator(".tn-app")
                app.locator('[data-object]').wait_for()
                # The legacy simple timesheet deliberately hides the formula
                # dock. Switch to the real full spreadsheet mode first.
                app.locator('[data-action="settings-menu"]').click()
                settings=page.locator("dialog.tn[open]")
                settings.locator("[data-table-mode]").select_option("full")
                settings.locator('[data-action="save-mode"]').click()
                settings.wait_for(state="hidden")
                app.locator('[data-view="table"]').click()
                grid=app.locator("table.tn-grid")
                grid.wait_for()
                app.locator('[data-action="formula-help"]').click()
                guide=page.locator("dialog.tn-formula-help-dialog[open]")
                guide.wait_for()
                assert 'Справка по формулам' in guide.inner_text()
                guide.locator('[data-formula-search]').fill('округл')
                hit=guide.locator('[data-function-name="ROUND"]')
                hit.wait_for()
                assert 'Округляет' in hit.inner_text()
                hit.locator('[data-formula-index]').click()
                guide.wait_for(state="hidden")
                editor=app.locator('[data-editor]')
                assert editor.input_value()=='=ROUND(A1;2)'
                assert editor.evaluate("input=>document.activeElement===input")
                mirror=app.locator('.tn-formula-render')
                assert mirror.locator('.tn-syntax-function').inner_text()=='ROUND'
                assert mirror.locator('.tn-syntax-ref').inner_text()=='A1'
                assert mirror.locator('.tn-syntax-number').inner_text()=='2'
                assert grid.locator('[data-cell="A1"].tn-syntax-reference').count()==1
                # Syntax does not write into the actual input or mutate caret.
                length=editor.evaluate("input=>input.value.length")
                assert editor.evaluate("input=>input.selectionStart")==length
                editor.fill('=SUM(A1:A2)+ROUND(B2;0)')
                assert mirror.locator('.tn-syntax-function').count()==2
                assert grid.locator('[data-cell="A1"].tn-syntax-reference').count()==1
                assert grid.locator('[data-cell="A2"].tn-syntax-reference').count()==1
                editor.fill('=IF(A1>0;"B2";3)')
                assert mirror.locator('.tn-syntax-string').inner_text()=='"B2"'
                assert grid.locator('[data-cell="B2"].tn-syntax-reference').count()==0
                editor.fill('123')
                assert app.locator('.tn-formula-editor.tn-syntax-active').count()==0
                assert mirror.inner_text()==''
                assert not failures,failures
                print("PASS mobile formula help: searchable rounding guide, example insertion, token colors and linked cell highlights")
                context.close()
            finally:browser.close()
    finally:
        server.shutdown();server.server_close();thread.join(timeout=5)
if __name__=="__main__":main()
