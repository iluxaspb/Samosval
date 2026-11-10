export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const btn = (label, action, extra = "") =>
  `<button type="button" data-action="${action}" ${extra}>${label}</button>`;
export const input = (name, value = "", extra = "") =>
  `<input name="${esc(name)}" value="${esc(value)}" ${extra}>`;
export const field = (label, html) => `<label>${esc(label)}${html}</label>`;
export function error(e) {
  const open = [...document.querySelectorAll("dialog.tn[open]")].at(-1);
  const target =
    open?.querySelector("[role=alert]") ||
    document.querySelector(".tn-app [role=alert]");
  if (target) target.textContent = e.message || e;
}
export function dialog(title, html, save) {
  const el = document.createElement("dialog");
  el.className = "tn";
  el.innerHTML = `<form><header><b>${esc(title)}</b>${btn("×", "close", 'aria-label="Закрыть"')}</header><div class="tn-dialog-body">${html}</div><p role="alert"></p><footer>${btn("Закрыть", "close")}${save ? '<button type="submit">Сохранить</button>' : ""}</footer></form>`;
  document.body.append(el);
  el.querySelectorAll("[data-action=close]").forEach(
    (b) => (b.onclick = () => el.close()),
  );
  el.onclose = () => el.remove();
  el.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    if (!save) return;
    const submit = el.querySelector("[type=submit]");
    submit.disabled = true;
    try {
      await save(new FormData(e.target), el);
      el.close();
    } catch (e) {
      el.querySelector("[role=alert]").textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  };
  el.showModal();
  if (el.querySelector('input[inputmode="decimal"],input[inputmode="numeric"]'))
    import("./number-input.mjs").then((m) => {
      if (el.isConnected) m.bindNumericFields(el);
    });
  return el;
}
export function message(title, text) {
  const el = dialog(
    title,
    `<textarea class="tn-message" aria-label="Текст сообщения">${esc(text)}</textarea><p>Редактируется только сообщение. Данные табеля не меняются.</p><div class="tn-tools">${btn("Поделиться", "share")}${btn("Скопировать текст", "copy")}</div><p data-status>Сообщение подготовлено</p>`,
  );
  const status = el.querySelector("[data-status]");
  el.querySelector("[data-action=share]").onclick = async () => {
    try {
      if (!navigator.share)
        throw Error("Системное меню недоступно. Используйте копирование.");
      status.textContent = "Открывается системное меню";
      await navigator.share({ text: el.querySelector("textarea").value });
      status.textContent =
        "Передано системному меню. Доставка не подтверждается приложением.";
    } catch (e) {
      status.textContent =
        e.name === "AbortError" ? "Отправка отменена" : e.message;
    }
  };
  el.querySelector("[data-action=copy]").onclick = async () => {
    try {
      await navigator.clipboard.writeText(el.querySelector("textarea").value);
      status.textContent = "Текст скопирован";
    } catch {
      el.querySelector("textarea").select();
      status.textContent = "Выделите и скопируйте текст через меню браузера";
    }
  };
  return el;
}
