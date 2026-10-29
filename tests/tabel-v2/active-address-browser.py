#!/usr/bin/env python3
"""Chromium acceptance: default object, free browsing and per-visit write warning."""
import argparse
import http.server
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium", default=None)
    args = parser.parse_args()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)
        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as play:
            browser = play.chromium.launch(executable_path=args.chromium, headless=True, chromium_sandbox=True)
            try:
                context = browser.new_context(viewport={"width":393,"height":852}, is_mobile=True, has_touch=True)
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(f"http://127.0.0.1:{server.server_port}/tests/tabel-v2/harness.html")
                page.wait_for_function("() => window.ready === true")
                page.evaluate("""() => {
                  window.snapshot.shift = {id:'shift-b',objectId:'site-b',objectName:'Объект Б',isActive:true};
                  localStorage.setItem(JSON.stringify(['tabel-v2-last-object',
                    session.projectId,session.workspaceId,session.uid]),'site-a');
                }""")
                page.locator("#open").click()
                selector = page.locator(".tn-app [data-object]")
                selector.wait_for()
                assert selector.input_value() == "site-b", "Active shift must override old selection"
                selector.select_option("site-a")
                page.locator('.tn-app [data-view="table"]').click()
                assert page.locator('dialog.tn:has-text("Изменение другого адреса")').count() == 0, "Viewing should not warn"

                def save_mode():
                    page.locator('.tn-app [data-action="settings-menu"]').click()
                    page.locator('dialog.tn [data-action="save-mode"]').click()

                save_mode()
                warning = page.locator('dialog.tn:has(> form > header > b:text-is("Изменение другого адреса"))')
                warning.wait_for()
                assert 'Объект Б' in warning.inner_text() and 'Объект А' in warning.inner_text()
                warning.locator('footer [data-action="close"]').click()
                warning.wait_for(state="hidden")
                assert page.locator('dialog.tn [data-action="save-mode"]').count() == 1, "No must not save"

                page.locator('dialog.tn [data-action="save-mode"]').click()
                warning.wait_for()
                warning.locator('[type="submit"]').click()
                warning.wait_for(state="hidden")
                page.locator('dialog.tn:has(.tn-settings-menu)').wait_for(state="hidden")

                # Same foreign object: first 'Да' grants consent only for this visit.
                save_mode()
                page.wait_for_timeout(250)
                assert warning.count() == 0, "Consent should avoid repeated warnings"
                page.locator('.tn-app [data-action="exit"]').click()

                # Re-enter the table: return to active Line object and reset consent.
                page.locator("#open").click()
                selector.wait_for()
                assert selector.input_value() == "site-b", "Reentry must choose active Line"
                selector.select_option("site-a")
                save_mode()
                warning.wait_for()
                warning.locator('footer [data-action="close"]').click()
                page.locator('dialog.tn[open] [data-action="close"]').first.click()
                page.locator('.tn-app [data-action="exit"]').click()

                # With no active shift, choose the latest closed shift from archive.
                page.evaluate("""() => {
                  window.snapshot.shift = null;
                  window.snapshot.archive = [{objectId:'site-a',closedAt:300},
                    {objectId:'site-b',closedAt:100}];
                }""")
                page.locator("#open").click()
                selector.wait_for()
                assert selector.input_value() == "site-a", "Last archive must become default"
                page.locator('.tn-app [data-action="exit"]').click()

                # Closing a zero-trip shift stores the newer address locally.
                page.evaluate("""() => {
                  localStorage.setItem('tabel-v2-last-closed:' +
                    session.projectId + ':' + session.workspaceId,
                    JSON.stringify({objectId:'site-b',closedAt:400}));
                }""")
                page.locator("#open").click()
                selector.wait_for()
                assert selector.input_value() == "site-b", "Newer last-closed shift must win"
                assert not errors, errors
                print("PASS mobile Tabel: active/closed defaults, free browse, No/Yes, consent per visit")
                context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

if __name__ == "__main__":
    main()
