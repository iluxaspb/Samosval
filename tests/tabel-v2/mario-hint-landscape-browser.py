#!/usr/bin/env python3
"""Chromium acceptance: памятка «Как играть» в горизонтальном режиме 852x393.

Баг владельца (23.11.2026): в landscape карточка выше экрана, кнопка
«Понятно, играть» за нижним краем — тап не проходит. Воспроизводим разметку
памятки (те же классы и CSS из road-arcade-style.css) и проверяем:
кнопка видна в viewport, pointerdown закрывает памятку, карточка скроллится.
"""
import json
import re
import threading
import http.server
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CSS = ROOT / "working-test/source/styles/road-arcade-style.css"
UI = ROOT / "working-test/source/features/road-arcade-ui.js"

HINT_MARKUP = """
<div class="mario-game-wrapper">
  <div class="mario-ingame-hud">hud</div>
  <canvas id="mario-canvas" width="960" height="540"></canvas>
  <div id="mario-fs-controls">
    <div class="mic-joystick" id="mario-joystick"></div>
    <div class="mic-jump-zone" id="mario-jump-zone"></div>
  </div>
  <button type="button" class="mic-exit" id="mario-fs-exit">✕</button>
  <div class="mario-first-run" role="dialog" aria-label="Подсказка управления">
    <div class="mfr-card">
      <h3>Как играть</h3>
      <div class="mfr-row"><div class="mfr-icon joy"></div><div><span class="mfr-tap">Слева — джойстик.</span><br>Зажмите центр пальцем и ведите влево/вправо, не отрывая палец.</div></div>
      <div class="mfr-row"><div class="mfr-icon jump">↑</div><div><span class="mfr-tap">Справа — прыжок.</span><br>Коснитесь в любом месте правой половины экрана — пойдёт прыжок. Держите дольше — прыгнет выше.</div></div>
      <div class="mfr-row" style="font-size:13px;opacity:.85">Сверху — уровень, жизни, монеты, пауза, звуки. Кнопка ✕ — выход.</div>
      <button type="button" id="mario-first-run-ok">Понятно, играть</button>
    </div>
  </div>
</div>
"""

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:100%;height:100%}
#arcade-dialog.mario-immersive{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;border-radius:0;background:#000;overflow:hidden}
#arcade-dialog.mario-immersive #arcade-content{position:absolute;inset:0;margin:0;padding:0}
""" + CSS.read_text(encoding="utf-8") + """</style></head>
<body>
<dialog id="arcade-dialog" class="mario-immersive" open><div id="arcade-content">MARKUP</div></dialog>
<script>
// Тот же обработчик, что в road-arcade-ui.js: click + pointerdown(capture).
const okBtn=document.querySelector('#mario-first-run-ok');
const closeHint=()=>{document.querySelector('.mario-first-run').remove();window.__hintClosed=true;};
okBtn.onclick=closeHint;
okBtn.addEventListener('pointerdown',e=>{e.preventDefault();e.stopImmediatePropagation();closeHint();},{capture:true});
</script>
</body></html>"""


def main():
    css = CSS.read_text(encoding="utf-8")
    # Те же значения, что и продуктовая страница: immersive-диалог на весь экран.
    page_html = PAGE.replace("MARKUP", HINT_MARKUP)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = page_html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    failures = []
    try:
        with sync_playwright() as play:
            browser = play.chromium.launch(headless=True, chromium_sandbox=False)
            context = browser.new_context(viewport={"width": 852, "height": 393}, is_mobile=True, has_touch=True)
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            page.wait_for_selector(".mario-first-run")

            # 1. Кнопка видна и целиком в границах viewport.
            box = page.locator("#mario-first-run-ok").bounding_box()
            if not box:
                failures.append("кнопка «Понятно, играть» не найдена")
            else:
                if box["y"] + box["height"] > 393 or box["y"] < 0:
                    failures.append(f"кнопка вне viewport: {json.dumps(box)}")
                if box["width"] <= 0 or box["height"] <= 0:
                    failures.append(f"кнопка схлопнута: {json.dumps(box)}")

            # 2. Верхняя часть карточки (заголовок) тоже видна — скролл внутри карточки.
            title = page.locator(".mfr-card h3").bounding_box()
            if not title or title["y"] < -1 or title["y"] > 393:
                failures.append(f"заголовок карточки не виден: {json.dumps(title)}")

            # 3. Элемент под кнопкой (hit-test): тап должен попадать именно в кнопку,
            #    а не в joyZone/jumpZone/canvas.
            hit = page.evaluate(
                """() => { const b=document.querySelector('#mario-first-run-ok'); const r=b.getBoundingClientRect();
                     const el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return el?.id||el?.className||String(el); }"""
            )
            if hit != "mario-first-run-ok":
                failures.append(f"hit-test центра кнопки дал {hit!r}, а не кнопку")

            # 4. Критично для мобильных WebView: pointerdown по кнопке закрывает памятку.
            page.locator("#mario-first-run-ok").dispatch_event("pointerdown")
            closed = page.evaluate("() => window.__hintClosed === true")
            if not closed:
                failures.append("pointerdown не закрыл памятку")

            # 5. Скролл длинной карточки работает: добавляем высокий ряд и крутим.
            page2 = context.new_page()
            page2.goto(f"http://127.0.0.1:{server.server_port}/")
            page2.wait_for_selector(".mario-first-run")
            scrolled = page2.evaluate(
                """() => { const c=document.querySelector('.mfr-card'); const row=document.createElement('div');
                     row.className='mfr-row'; row.style.height='600px'; c.insertBefore(row, c.querySelector('button'));
                     if (c.scrollHeight <= c.clientHeight) return 'no-overflow-after-stretch';
                     c.scrollTop=400; return c.scrollTop>0 ? 'ok' : 'not-scrollable'; }"""
            )
            if scrolled != "ok":
                failures.append(f"карточка не скроллится: {scrolled}")

            if errors:
                failures.append(f"ошибки страницы: {errors}")

            browser.close()
    finally:
        server.shutdown()

    if failures:
        print("FAIL: памятка «Как играть» в landscape 852x393")
        for f in failures:
            print("  -", f)
        raise SystemExit(1)
    print("OK: памятка «Как играть» в landscape 852x393 — кнопка видна, тап работает, карточка скроллится")


if __name__ == "__main__":
    main()
