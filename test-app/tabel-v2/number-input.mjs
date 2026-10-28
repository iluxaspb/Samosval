import { esc, btn, dialog } from "./messages.mjs";
// One keypad for table cells, shift hours, material quantities and numeric forms.
export function numberInput(title, initial, save, { presets = true } = {}) {
  let value = String(initial ?? ""),
    replace = true;
  const el = dialog(
    title,
    `<output data-hours-value aria-live="polite">${esc(value || "0")}</output><div class="tn-numberpad">${["7", "8", "9", "4", "5", "6", "1", "2", "3", ",", "0", "⌫"].map((x) => btn(x, "digit", `data-digit="${x}"`)).join("")}</div>${presets ? `<div class="tn-quick-hours">${[10, 11, 12, 13, 14].map((n) => btn(n, "preset", `data-value="${n}" data-preset="${n}" ${n === 12 ? 'class="tn-twelve"' : ""}`)).join("")}</div>` : ""}`,
    async () => save(value),
  );
  el.classList.add("tn-hours-dialog");
  const footer = el.querySelector("footer"),
    submit = el.querySelector("[type=submit]");
  const clear = document.createElement("button");
  clear.type = "button";
  clear.dataset.action = "clear-hours";
  clear.textContent = "Очистить";
  footer.insertBefore(clear, submit);
  const update = () =>
    (el.querySelector("[data-hours-value]").textContent = value || "0");
  let busy = false;
  const commit = async () => {
    if (busy) return;
    busy = true;
    el.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await save(value);
      el.close();
    } catch (e) {
      el.querySelector("[role=alert]").textContent = e.message || e;
    } finally {
      busy = false;
      el.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  };
  el.querySelectorAll("[data-value]").forEach(
    (b) =>
      (b.onclick = () => {
        value = b.dataset.value;
        update();
        void commit();
      }),
  );
  el.querySelectorAll("[data-digit]").forEach(
    (b) =>
      (b.onclick = () => {
        const x = b.dataset.digit;
        if (x === "⌫") value = value.slice(0, -1);
        else {
          if (replace) value = "";
          if (x !== "," || !/[.,]/.test(value)) value += x;
        }
        replace = false;
        update();
      }),
  );
  clear.onclick = () => {
    value = "";
    replace = true;
    update();
  };
  return el;
}
export function bindNumericFields(root) {
  for (const input of root.querySelectorAll(
    'input[inputmode="decimal"],input[inputmode="numeric"]',
  )) {
    if (input.dataset.numericBound || input.readOnly || input.disabled) return;
    input.dataset.numericBound = "";
    input.readOnly = true;
    input.inputMode = "none";
    input.onclick = () =>
      numberInput(
        input.closest("label")?.firstChild.textContent || "Число",
        input.value,
        (value) => {
          input.value = value;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { presets: /час/i.test(input.closest("label")?.textContent || "") },
      );
  }
}
