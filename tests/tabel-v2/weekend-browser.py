#!/usr/bin/env python3
"""Chromium check: Saturday/Sunday shading and explicitly registered day off."""
import argparse
import http.server
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--chromium", default=None)
    args=parser.parse_args()
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self,*a,**kw):
            super().__init__(*a,directory=str(ROOT),**kw)
        def log_message(self,*args): pass
    server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        with sync_playwright() as play:
            browser=play.chromium.launch(executable_path=args.chromium,headless=True,chromium_sandbox=True)
            try:
                ctx=browser.new_context(viewport={"width":393,"height":852},is_mobile=True,has_touch=True)
                page=ctx.new_page()
                errors=[]
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(f"http://127.0.0.1:{server.server_port}/tests/tabel-v2/harness.html")
                page.wait_for_function("() => window.ready === true")
                page.locator("#open").click()
                app=page.locator(".tn-app")
                app.locator('[data-object]').wait_for()
                for d,off in [("2026-10-24",False),("2026-10-25",True),("2026-10-28",True)]:
                    app.locator('[data-action="add-day"]').click()
                    modal=page.locator('dialog.tn[open]')
                    modal.locator('[name="date"]').fill(d)
                    modal.locator('[name="dayOff"]').set_checked(off)
                    modal.locator('[type="submit"]').click()
                    modal.wait_for(state="hidden")
                app.locator(".tn-day-off-banner").wait_for()
                assert "28.10.2026" in app.locator(".tn-day-off-banner").inner_text()
                app.locator('[data-action="add-day"]').click()
                modal=page.locator('dialog.tn[open]')
                assert modal.locator('[name="dayOff"]').is_checked(), "Previously marked weekday must persist"
                modal.locator('[data-action="close"]').first.click()
                modal.wait_for(state="hidden")

                app.locator('[data-view="table"]').click()
                grid=app.locator("table.tn-grid.tn-linked")
                grid.wait_for()
                for d in ("24.10.2026","25.10.2026","28.10.2026"):
                    cell=grid.locator('td.tn-weekend-date[title="'+d+'"]')
                    cell.wait_for()
                    assert cell.count()==1, "Off date not retained as separate table column: "+d
                for d,abbr in [("24.10.2026","Сб"),("25.10.2026","Выходной"),
                               ("28.10.2026","Выходной")]:
                    assert abbr in grid.locator('td.tn-weekend-date[title="'+d+'"]').inner_text()
                assert grid.locator('td.tn-weekend-date[title="26.10.2026"]').count()==0
                assert grid.locator('td.tn-weekend-date[title="27.10.2026"]').count()==0
                assert grid.locator('td[title="26.10.2026"]').count()==1, "Monday should remain unshaded"
                overlay=grid.locator('td.tn-explicit-day-off[title="28.10.2026"]')
                assert overlay.count()==1
                props=overlay.evaluate("""td=>({
                  fill:td.style.background,
                  overlay:getComputedStyle(td,'::after').backgroundImage,
                  content:getComputedStyle(td,'::after').content
                })""")
                assert props["fill"], "Existing date header color must be preserved"
                assert "gradient" in props["overlay"] and props["content"] != "none",props
                assert grid.locator('tbody tr:nth-child(3) td.tn-weekend').count()>=3, "Weekend shade must extend vertically across data rows"
                assert not errors,errors
                print("PASS weekend overlay: Saturday/Sunday + weekday off, separate dated columns and original fills")
                ctx.close()
            finally: browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

if __name__=="__main__": main()
