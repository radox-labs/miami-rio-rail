// POST /api/access against a stubbed fetch: validation, honeypot, header injection, rate limit.
// Run: node scripts/access.test.mjs (no network, no keys, no real email).
import assert from "node:assert/strict";
import send from "../page/api/access.js";

const KEY = "re_test_secret_do_not_leak";
let calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: "x" }) }; };

let ip = 0;
async function post(body, { from = `10.0.0.${++ip}`, method = "POST" } = {}) {
  const req = { method, headers: { "x-forwarded-for": from }, query: {}, body };
  const res = { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await send(req, res);
  return res;
}
const ok = { name: "Ana Teste", email: "ana@example.com", company: "Acme Freight", role: "Ops", use: "Run handovers for our Santos to Miami lane." };

// 1. no key → 503 E_EMAIL_NOT_CONFIGURED, nothing sent
delete process.env.RESEND_API_KEY;
let r = await post(ok);
assert.equal(r.code, 503);
assert.equal(r.body.error.code, "E_EMAIL_NOT_CONFIGURED");
assert.equal(calls.length, 0);

process.env.RESEND_API_KEY = KEY;
delete process.env.ACCESS_TO; delete process.env.ACCESS_FROM;

// 2. honeypot filled → 200, fetch not called
r = await post({ ...ok, website: "http://spam.example" });
assert.equal(r.code, 200);
assert.equal(calls.length, 0, "honeypot must not send");

// 3. invalid email, missing field, too long → 400
for (const bad of [{ ...ok, email: "not-an-email" }, { ...ok, email: "a@b.c\r\nBcc: x@y.z" }, { ...ok, company: "" }, { ...ok, use: "x".repeat(1001) }]) {
  r = await post(bad);
  assert.equal(r.code, 400, JSON.stringify(bad).slice(0, 80));
  assert.equal(r.body.error.code, "E_FIELD");
}
r = await post("{not json");
assert.equal(r.code, 400);
assert.equal(calls.length, 0);

// 4. CR/LF in company → stripped from the subject
r = await post({ ...ok, company: "Evil\r\nBcc: victim@example.com" });
assert.equal(r.code, 200);
const injected = JSON.parse(calls.pop().init.body);
assert.ok(!/[\r\n]/.test(injected.subject), "no CR/LF in subject");
assert.equal(injected.subject, "Radox Rail API access — Evil Bcc: victim@example.com");

// 5. valid → one call to Resend with the right to/reply_to and no key in the body
r = await post(ok);
assert.equal(r.code, 200);
assert.equal(r.body.sent, true);
assert.equal(calls.length, 1);
const [c] = calls;
assert.equal(c.url, "https://api.resend.com/emails");
assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
const sent = JSON.parse(c.init.body);
assert.deepEqual(sent.to, ["pedro@radox.net"]);
assert.equal(sent.reply_to, "ana@example.com");
assert.equal(sent.from, "Radox Rail <onboarding@resend.dev>");
assert.equal(sent.subject, "Radox Rail API access — Acme Freight");
assert.match(sent.text, /Santos to Miami/);
assert.ok(!c.init.body.includes(KEY), "key must not be in the email body");
assert.ok(!JSON.stringify(r.body).includes(KEY), "key must not be in the response");
calls = [];

// 6. ACCESS_TO / ACCESS_FROM override the defaults
process.env.ACCESS_TO = "team@example.com"; process.env.ACCESS_FROM = "Rail <rail@example.com>";
await post(ok);
assert.deepEqual(JSON.parse(calls.pop().init.body).to, ["team@example.com"]);
delete process.env.ACCESS_TO; delete process.env.ACCESS_FROM;

// 7. provider error → 502 generic, key not echoed
globalThis.fetch = async () => ({ ok: false, status: 401 });
r = await post(ok);
assert.equal(r.code, 502);
assert.ok(!JSON.stringify(r.body).includes(KEY));
globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };

// 8. GET → 405
r = await post(ok, { method: "GET" });
assert.equal(r.code, 405);

// 9. the 4th request from the same IP within 10 minutes → 429
const same = { from: "203.0.113.7" };
for (let i = 0; i < 3; i++) assert.equal((await post(ok, same)).code, 200);
r = await post(ok, same);
assert.equal(r.code, 429);
assert.equal(r.body.error.code, "E_RATE_LIMIT");

console.log("access: 9 checks passed");
