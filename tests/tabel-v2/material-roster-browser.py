#!/usr/bin/env python3
"""Real local Chromium acceptance: catalog rename, per-shift pump and materials."""
import argparse
import http.server
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--chromium",default=None)
    args=parser.parse_args()
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT),**kw)
        def log_message(self,*a):pass
    server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        with sync_playwright() as play:
            browser=play.chromium.launch(executable_path=args.chromium,headless=True,chromium_sandbox=True)
            try:
                context=browser.new_context(viewport={"width":393,"height":852},is_mobile=True,has_touch=True)
                page=context.new_page()
                errors=[]
                page.on("pageerror",lambda e:errors.append(str(e)))
                page.goto(f"http://127.0.0.1:{server.server_port}/tests/tabel-v2/harness.html")
                page.wait_for_function("() => window.ready===true")
                page.locator("#open").click()
                app=page.locator(".tn-app")
                app.locator('[data-object]').wait_for()
                assert app.locator('[data-object]').input_value()=="site-a"
                page.evaluate("""() => {
                    objects[0].name='Исправленный адрес';
                    window.dispatchEvent(new Event('samosval-objects-changed'));
                }""")
                page.wait_for_function("""() =>
                  [...document.querySelectorAll('.tn-app [data-object] option')]
                    .some(o=>o.value==='site-a' && o.textContent==='Исправленный адрес')""")
                app.locator('[data-action="add-day"]').click()
                newday=page.locator('dialog.tn[open]')
                newday.locator('[type=submit]').click()
                newday.wait_for(state="hidden")
                app.locator('[data-action="choose-roster"]').wait_for()

                app.locator('[data-action="choose-roster"]').click()
                roster=page.locator('dialog.tn[open]')
                roster.locator('[data-choice="water"]').check()
                roster.locator('[data-pump="water"]').check()
                roster.locator('[type=submit]').click()
                roster.wait_for(state="hidden")
                app.locator('[data-card="water"]').wait_for()
                assert "Помпа" in app.locator('[data-card="water"]').inner_text()

                app.locator('[data-action="choose-roster"]').click()
                roster=page.locator('dialog.tn[open]')
                roster.locator('[data-pump="water"]').uncheck()
                roster.locator('[type=submit]').click()
                roster.wait_for(state="hidden")
                assert "Помпа" not in app.locator('[data-card="water"]').inner_text()

                app.locator('[data-tab="values"]').click()
                app.locator('[data-action="add-materials"]').wait_for()
                app.locator('[data-action="add-materials"]').click()
                materials=page.locator('dialog.tn[open]')
                materials.locator('[name="newName"]').fill('Щебень тестовый')
                materials.locator('[name="newUnit"]').fill('м³')
                materials.locator('[name="newDirection"]').fill('На склад')
                materials.locator('[type=submit]').click()
                materials.wait_for(state="hidden")
                assert "Щебень тестовый" in app.locator('[data-values]').inner_text()

                app.locator('[data-view="catalog"]').click()
                app.locator('[data-tab="materials"]').click()
                assert "Щебень тестовый" in app.locator('.tn-catalog-list').inner_text()
                app.locator('[data-view="shift"]').click()
                app.locator('[data-shift]').select_option('night')
                app.locator('[data-action="add-day"]').click()
                later=page.locator('dialog.tn[open]')
                later.locator('[name="shift"]').select_option('night')
                later.locator('[type=submit]').click()
                later.wait_for(state="hidden")
                app.locator('[data-tab="values"]').click()
                assert "Щебень тестовый" not in app.locator('[data-values]').inner_text(), "Material leaked into other shift"
                # Create machine with misleading title and explicitly OTHER category;
                # then choose a color and reclassify it as a mill.
                app.locator('[data-view="catalog"]').click()
                app.locator('[data-tab="equipment"]').click()
                app.locator('[data-action="add-catalog"]').click()
                create=page.locator('dialog.tn[open]:has(> form > header > b:text-is("Добавить технику в базу"))')
                create.wait_for()
                create.locator('[name="name"]').fill('Фреза испытательная')
                create.locator('[name="kind"]').select_option('other')
                create.locator('[data-color-field="color"]').click()
                palette=page.locator('dialog.tn[open]:has(> form > header > b:text-is("Цвет техники — выбрать"))')
                palette.wait_for()
                palette.locator('[data-family="blue"]').click()
                chosen_color=palette.locator('[data-color]').nth(3).get_attribute('data-color')
                palette.locator('[data-color]').nth(3).click()
                palette.wait_for(state='hidden')
                assert create.locator('[name="color"]').input_value()==chosen_color
                create.locator('[type="submit"]').click()
                create.wait_for(state='hidden')

                item=app.locator('.tn-catalog-row').filter(has_text='Фреза испытательная')
                item.wait_for()
                item.locator('[data-action="edit-catalog"]').click()
                edit=page.locator('dialog.tn[open]:has(> form > header > b:text-is("Изменить: Фреза испытательная"))')
                edit.wait_for()
                assert edit.locator('[name="kind"]').input_value()=='other'
                assert edit.locator('[name="color"]').input_value()==chosen_color
                edit.locator('[name="kind"]').select_option('mill')
                edit.locator('[type=submit]').click()
                edit.wait_for(state='hidden')

                item=app.locator('.tn-catalog-row').filter(has_text='Фреза испытательная')
                item.locator('[data-action="edit-catalog"]').click()
                edit=page.locator('dialog.tn[open]:has(> form > header > b:text-is("Изменить: Фреза испытательная"))')
                edit.wait_for()
                assert edit.locator('[name="kind"]').input_value()=='mill'
                assert edit.locator('[name="color"]').input_value()==chosen_color
                edit.locator('[data-action="close"]').first.click()
                edit.wait_for(state='hidden')

                app.locator('[data-view="request"]').click()
                app.locator('[data-action="lunch"]').click()
                lunch=page.locator('dialog.tn[open]:has(> form > header > b:text-is("Заказ обеда"))')
                lunch.wait_for()
                assert 'Фреза испытательная — 2 чел.' in lunch.inner_text()
                lunch.locator('[data-action="close"]').first.click()
                lunch.wait_for(state='hidden')
                assert not errors,errors
                print("PASS test 3.4.56: live address rename, shift pump on/off, shared materials, equipment category, color and 2 mill lunches")
                context.close()
            finally:browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
if __name__=="__main__":main()
