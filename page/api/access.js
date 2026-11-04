// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// POST /api/access — the "Request access" form. Sends one plain-text email to the team via
// Resend's HTTP API. Without RESEND_API_KEY it answers 503 E_EMAIL_NOT_CONFIGURED and the page
// falls back to a mailto link. The key is never logged or returned.
import { handler, limitIp, ApiError } from "./_lib/rail.js";

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const LIMITS = { name: 100, email: 200, company: 120, role: 100, use: 1000 };
const REQUIRED = ["name", "email", "company", "use"];
const oneLine = (s) => s.replace(/[\r\n]+/g, " ").trim(); // header-bound fields: no CR/LF

export function parseAccess(body) {
  const b = body && typeof body === "object" ? body : {};
  const v = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, typeof b[k] === "string" ? b[k].trim() : ""]));
  for (const k of REQUIRED) if (!v[k]) throw new ApiError(400, "E_FIELD", `"${k}" is required.`, { field: k });
  for (const [k, max] of Object.entries(LIMITS)) {
    if (v[k].length > max) throw new ApiError(400, "E_FIELD", `"${k}" is too long (at most ${max} characters).`, { field: k });
  }
  for (const k of ["name", "email", "company", "role"]) v[k] = oneLine(v[k]);
  if (!EMAIL.test(v.email)) throw new ApiError(400, "E_FIELD", "Enter a valid email address.", { field: "email" });
  return { ...v, bot: typeof b.website === "string" && b.website.trim() !== "" };
}

export default handler(["POST"], async (req) => {
  limitIp(req, "access", 3, 10 * 60_000);
  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return null; } })() : req.body;
  const v = parseAccess(body);
  if (v.bot) return [200, { sent: true }]; // honeypot filled: pretend success, send nothing
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new ApiError(503, "E_EMAIL_NOT_CONFIGURED", "Email is not set up on this server. Write to pedro@radox.net.");
  const text = [
    `Name: ${v.name}`, `Work email: ${v.email}`, `Company: ${v.company}`, `Role: ${v.role || "-"}`,
    "", "What they want to run on the rail:", v.use, "", "Sent from the Request access form.",
  ].join("\n");
  let r;
  try {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.ACCESS_FROM || "Radox Rail <onboarding@resend.dev>",
        to: [process.env.ACCESS_TO || "pedro@radox.net"],
        reply_to: v.email,
        subject: `Radox Rail API access — ${v.company}`,
        text,
      }),
    });
  } catch {
    r = null;
  }
  if (!r?.ok) {
    console.error("access: email provider answered", r ? r.status : "no response");
    throw new ApiError(502, "E_EMAIL_FAILED", "The request could not be sent. Write to pedro@radox.net.");
  }
  return [200, { sent: true }];
});
