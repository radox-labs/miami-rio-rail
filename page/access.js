// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// "Request access" form. Progressive enhancement: every a[data-access] keeps its mailto href
// for visitors without JS; with JS the click opens a <dialog> that POSTs to /api/access.
// If the API is unavailable (no email key, network or 5xx), it falls back to a pre-filled mailto.
// All text goes in through textContent; user data never touches innerHTML.
const TO = "pedro@radox.net";
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const MAX_NOTE = 1000;

const FIELDS = [
  { name: "name", label: "Name", type: "text", required: true, max: 100, autocomplete: "name" },
  { name: "email", label: "Work email", type: "email", required: true, max: 200, autocomplete: "email" },
  { name: "company", label: "Company", type: "text", required: true, max: 120, autocomplete: "organization" },
  { name: "role", label: "Role (optional)", type: "text", required: false, max: 100, autocomplete: "organization-title" },
  { name: "use", label: "What do you want to run on the rail?", type: "textarea", required: true, max: MAX_NOTE },
];

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
  if (text !== undefined) n.textContent = text;
  return n;
}

export function mailtoFor(v) {
  const subject = `Radox Rail API access — ${v.company}`;
  const body = [
    `Name: ${v.name}`, `Work email: ${v.email}`, `Company: ${v.company}`, `Role: ${v.role || "-"}`,
    "", "What I want to run on the rail:", v.use,
  ].join("\n");
  return `mailto:${TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

let dialog, form, status, opener;

function build() {
  dialog = el("dialog", { class: "acc", "aria-labelledby": "acc-title", "aria-describedby": "acc-lede" });
  const close = el("button", { type: "button", class: "acc-x", "aria-label": "Close" }, "×");
  close.addEventListener("click", () => dialog.close());
  const title = el("h2", { id: "acc-title" }, "Request access");
  const lede = el("p", { id: "acc-lede", class: "acc-lede" }, "Tell us who you are and what you want to run on the rail. We reply by email.");
  form = el("form", { novalidate: true });
  for (const f of FIELDS) {
    const id = `acc-${f.name}`;
    const wrap = el("div", { class: "acc-f" });
    wrap.append(el("label", { for: id }, f.label));
    const input = f.type === "textarea"
      ? el("textarea", { id, name: f.name, rows: 4, maxlength: f.max, required: f.required, "aria-describedby": `${id}-err ${id}-count` })
      : el("input", { id, name: f.name, type: f.type, maxlength: f.max, required: f.required, autocomplete: f.autocomplete, "aria-describedby": `${id}-err` });
    wrap.append(input);
    if (f.type === "textarea") {
      const count = el("span", { id: `${id}-count`, class: "acc-count" }, `0 / ${f.max}`);
      input.addEventListener("input", () => { count.textContent = `${input.value.length} / ${f.max}`; });
      wrap.append(count);
    }
    wrap.append(el("span", { id: `${id}-err`, class: "acc-err" }));
    form.append(wrap);
  }
  // honeypot: hidden from people and assistive tech, bots fill it
  const hp = el("div", { class: "acc-hp", "aria-hidden": "true" });
  hp.append(el("label", { for: "acc-website" }, "Website"), el("input", { id: "acc-website", name: "website", type: "text", tabindex: "-1", autocomplete: "off" }));
  form.append(hp);
  status = el("p", { class: "acc-status", role: "status", "aria-live": "polite" });
  const submit = el("button", { type: "submit", class: "acc-send" }, "Send");
  // LGPD art. 9: say why the data is collected, who gets it, and how to have it erased, before it is sent.
  const notice = el("p", { class: "acc-fine" }, `We use these details only to reply to this request. They reach the Radox team by email through Resend (USA). To see or erase them, write to ${TO}.`);
  form.append(notice, status, submit);
  form.addEventListener("submit", onSubmit);
  dialog.append(close, title, lede, form);
  dialog.addEventListener("close", () => { opener?.focus(); });
  // keep Tab inside the dialog (showModal already makes the page inert)
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [...dialog.querySelectorAll("button, input, textarea, [tabindex='-1'].acc-done")]
      .filter((n) => !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // click on the backdrop closes
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  document.body.append(dialog);
}

function values() {
  const d = new FormData(form);
  return Object.fromEntries(["name", "email", "company", "role", "use", "website"].map((k) => [k, String(d.get(k) ?? "").trim()]));
}

function validate(v) {
  let first = null;
  for (const f of FIELDS) {
    const input = form.elements[f.name];
    let msg = "";
    if (f.required && !v[f.name]) msg = "Required.";
    else if (f.name === "email" && !EMAIL.test(v.email)) msg = "Enter a valid email address.";
    else if (v[f.name].length > f.max) msg = `At most ${f.max} characters.`;
    form.querySelector(`#acc-${f.name}-err`).textContent = msg;
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    if (msg && !first) first = input;
  }
  first?.focus();
  return !first;
}

function done(text) {
  form.hidden = true;
  const msg = el("p", { class: "acc-done", role: "status", tabindex: "-1" }, text);
  dialog.append(msg);
  msg.focus();
}

async function onSubmit(e) {
  e.preventDefault();
  const v = values();
  if (!validate(v)) return;
  const btn = form.querySelector(".acc-send");
  btn.disabled = true;
  status.textContent = "Sending…";
  let ok = false;
  try {
    const r = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
    if (r.ok) ok = true;
    else if (r.status === 400 || r.status === 429) {
      const body = await r.json().catch(() => ({}));
      status.textContent = body?.error?.message || "Could not send. Check the fields and try again.";
      btn.disabled = false;
      return;
    }
  } catch { /* network error: fall through to mailto */ }
  if (ok) return done("Thanks. Your request is in; we reply by email.");
  done("Opening your email app with the request filled in. Press send there.");
  window.location.href = mailtoFor(v);
}

function open(e, a) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (typeof HTMLDialogElement !== "function") return; // old browser: keep the mailto link
  e.preventDefault();
  opener = a;
  if (dialog) dialog.remove(); // fresh form each time
  build();
  dialog.showModal();
  form.elements.name.focus();
}

for (const a of document.querySelectorAll("a[data-access]")) a.addEventListener("click", (e) => open(e, a));
