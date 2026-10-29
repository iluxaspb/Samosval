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

                # The destructive action lives INSIDE the add-shift dialog, not outside.
                assert app.locator('main > .tn-tools [data-action="delete-shift"]').count() == 0
                app.locator('[data-action="add-day"]').click()
                modal=page.locator('dialog.tn[open]')
                delete=modal.locator('[data-action="delete-shift"]')
                assert delete.is_visible(), "Existing shift should offer deletion inside add menu"
                delete.click()
                confirm=page.locator('dialog.tn[open]').last
                assert "Удалить смену?" in confirm.inner_text()
                confirm.locator('[data-action="close"]').first.click()
                modal.locator('[data-action="close"]').first.click()
                app.locator('[data-view="table"]').click()
                grid=app.locator("table.tn-grid.tn-linked")
                grid.wait_for()
                for d in ("24.10.2026","25.10.2026","28.10.2026"):
                    cell=grid.locator('td.tn-weekend-date[title="'+d+'"]')
                    cell.wait_for()
                    assert cell.count()==1, "Off date not retained as separate table column: "+d
                for d in ("24.10.2026","25.10.2026","28.10.2026"):
                    cell=grid.locator('td.tn-weekend-date[title="'+d+'"]')
                    assert cell.get_attribute('data-rest-label') is None, "No weekday badge should be visible"
                    assert cell.evaluate("td=>getComputedStyle(td,'::before').content") in ("none","normal"), "No label pseudo-element should remain"
                    lines=cell.inner_text().splitlines()
                    assert len(lines)==2 and lines[0]==d[:5] and lines[1]=="День", (d,lines)
                # Regression for the displaced weekend header shown on the
                # user's phone: weekend header cells must share the precise
                # sticky top and height of an ordinary weekday, while scrolling.
                regular=grid.locator('td[title="23.10.2026"]')
                regular.wait_for()
                assert regular.evaluate("td=>getComputedStyle(td).position") == "sticky"
                for d in ("24.10.2026","25.10.2026","28.10.2026"):
                    cell=grid.locator('td.tn-weekend-date[title="'+d+'"]')
                    assert cell.evaluate("td=>getComputedStyle(td).position") == "sticky"
                def assert_aligned():
                    ref=regular.bounding_box()
                    assert ref
                    for d in ("24.10.2026","25.10.2026","28.10.2026"):
                        bb=grid.locator('td.tn-weekend-date[title="'+d+'"]').bounding_box()
                        assert bb
                        assert abs(bb["y"]-ref["y"])<2, (d,bb,ref)
                        assert abs(bb["height"]-ref["height"])<2, (d,bb,ref)
                assert_aligned()
                app.locator('.tn-grid-scroll').evaluate("(el)=>el.scrollTop+=125")
                page.wait_for_timeout(200)
                assert_aligned()
                assert grid.locator('td.tn-weekend-date[title="26.10.2026"]').count()==0
                assert grid.locator('td.tn-weekend-date[title="27.10.2026"]').count()==0
                assert grid.locator('td[title="26.10.2026"]').count()==1, "Monday should remain unshaded"
                overlay=grid.locator('td.tn-explicit-day-off[title="28.10.2026"]')
                assert overlay.count()==1
                props=overlay.evaluate("""td=>({
                  fill:td.style.background,
                  overlay:getComputedStyle(td,'::after').backgroundImage,
                  tint:getComputedStyle(td,'::after').backgroundColor,
                  content:getComputedStyle(td,'::after').content
                })""")
                assert props["fill"], "Existing date header color must be preserved"
                assert (("gradient" in props["overlay"]) or
                        (props["tint"].startswith("rgba(") and props["tint"] != "rgba(0, 0, 0, 0)")) and props["content"] != "none",props
                assert grid.locator('tbody tr:nth-child(3) td.tn-weekend').count()>=3, "Weekend shade must extend vertically across data rows"
                # Ghost resize preview for both axes, with integral persisted values.
                app.locator('[data-action="new-sheet"]').click()
                if page.locator('dialog.tn[open]').count():
                    sheet_dialog=page.locator('dialog.tn[open]')
                    sheet_dialog.locator('[name="type"]').select_option("blank")
                    sheet_dialog.locator('[type="submit"]').click()
                    sheet_dialog.wait_for(state="hidden")
                grid=app.locator("table.tn-grid:not(.tn-linked)")
                grid.wait_for()
                for handle,dx,dy,selector in [('[data-resize-col="0"]',35.6,0,'.tn-resize-guide-col'),('[data-resize-row="0"]',0,15.8,'.tn-resize-guide-row')]:
                    box=grid.locator(handle).bounding_box()
                    assert box,(handle,"resize handle missing")
                    x,y=box['x']+box['width']/2,box['y']+box['height']/2
                    page.mouse.move(x,y)
                    page.mouse.down()
                    page.mouse.move(x+dx,y+dy,steps=5)
                    guide=app.locator(selector)
                    assert guide.count()==1 and guide.is_visible(), "Expected visible resizing guide for "+handle
                    assert "px" in guide.inner_text(), "Resize guide must show integer pixel size"
                    page.mouse.up()
                    guide.wait_for(state="detached")
                app.locator('[data-action="format"]').click()
                fm=page.locator('dialog.tn[open]')
                for name in ("width","height"):
                    val=fm.locator('[name="'+name+'"]').input_value()
                    assert val.isdigit(),(name,val)
                    assert fm.locator('[name="'+name+'"]').get_attribute("step")=="1"
                fm.locator('[data-action="close"]').first.click()
                assert not errors,errors
                print("PASS weekend overlay: Saturday/Sunday + weekday off, separate dated columns and original fills")
                ctx.close()
            finally: browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

if __name__=="__main__": main()
