// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// One check per API endpoint against Stellar testnet, plus the refusals. Writes proofs/api-check.json.
//   node scripts/api-check.mjs [base URL]      default https://rio-miami-rail.vercel.app
// The sandbox steps send real testnet transactions (one new shipment per run).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "https://rio-miami-rail.vercel.app";
const DEMO = "31b4cff785831659b4ecb8fd3e7382f9760a12ef45ef7eb30f45b3b6911a5e37";
const out = { base: BASE, network: "testnet", run_at: new Date().toISOString(), checks: [] };
let failed = 0;

async function check(name, method, path, want, body) {
  const r = await fetch(BASE + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body && JSON.stringify(body) });
  const j = await r.json();
  const ok = r.status === want.status && (!want.code || j.error?.code === want.code) && (!want.test || want.test(j));
  if (!ok) failed++;
  const c = { name, request: `${method} ${path}${body ? " " + JSON.stringify(body) : ""}`, status: r.status, ok,
    code: j.error?.code, refused_by: j.error?.refused_by, tx: j.tx?.hash, explorer: j.tx?.explorer };
  out.checks.push(c);
  console.log(ok ? "ok  " : "FAIL", r.status, name, c.tx ?? c.code ?? "");
  return j;
}

await check("read demo shipment", "GET", `/api/shipments/${DEMO}`, { status: 200, test: (j) => j.source === "live" && j.shipment.status === "Delivered" });
await check("read: bad key", "GET", "/api/shipments/not-a-key", { status: 400, code: "E_KEY" });
await check("read: unknown key", "GET", `/api/shipments/${"0".repeat(64)}`, { status: 404, code: "E_NOT_FOUND" });
const MAINNET_KEY = "5dc2e39a8560dd99f19ec5034431b5e1ae979f5941969bbdb6f86fcd25656b2d"; // proofs/mainnet.json
await check("read mainnet shipment", "GET", `/api/shipments/${MAINNET_KEY}?network=mainnet`, { status: 200, test: (j) => j.network === "mainnet" && j.shipment.status === "Delivered" && j.shipment.seq === 4 });
await check("mainnet history", "GET", `/api/shipments/${MAINNET_KEY}/history?network=mainnet`, { status: 200, test: (j) => j.head_matches === true });
await check("sandbox stays on testnet", "POST", "/api/sandbox/shipments?network=mainnet", { status: 400, code: "E_TESTNET_ONLY" });
await check("history demo shipment", "GET", `/api/shipments/${DEMO}/history`, { status: 200, test: (j) => j.head_matches === true });
const o = await check("sandbox open", "POST", "/api/sandbox/shipments", { status: 201, test: (j) => j.tx?.hash && j.shipment.status === "Open" });
const k = o.shipment?.key;
out.sandbox_key = k;
if (k) {
  const p = `/api/sandbox/shipments/${k}`;
  await check("handover 1 (warehouse -> trucker)", "POST", `${p}/handover`, { status: 200, test: (j) => j.shipment.seq === 1 && j.tx.signers.length === 2 });
  await check("refusal: wrong company hands over", "POST", `${p}/handover`, { status: 409, code: "E_WRONG_CUSTODIAN" }, { from: "customs" });
  await check("refusal: assurance 0", "POST", `${p}/handover`, { status: 409, code: "E_BAD_ASSURANCE" }, { assurance: 0 });
  await check("refusal: early delivery", "POST", `${p}/deliver`, { status: 409, code: "E_NOT_FINAL" });
  for (let i = 2; i <= 4; i++) await check(`handover ${i}`, "POST", `${p}/handover`, { status: 200, test: (j) => j.shipment.seq === i });
  await check("route complete", "POST", `${p}/handover`, { status: 409, code: "E_ROUTE_COMPLETE" });
  await check("deliver", "POST", `${p}/deliver`, { status: 200, test: (j) => j.shipment.status === "Delivered" });
  await check("refusal: handover after delivery", "POST", `${p}/handover`, { status: 409, code: "E_NOT_OPEN" });
  await check("read sandbox shipment", "GET", `/api/shipments/${k}`, { status: 200, test: (j) => j.shipment.registry_name === "sandbox" && j.shipment.status === "Delivered" });
  await check("history sandbox shipment, head recomputed", "GET", `/api/shipments/${k}/history`, { status: 200, test: (j) => j.head_matches === true && j.steps.length === 6 });
}
out.failed = failed;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "proofs", "api-check.json"), JSON.stringify(out, null, 2) + "\n");
console.log(failed ? `${failed} failed` : `all ${out.checks.length} passed -> proofs/api-check.json`);
process.exit(failed ? 1 : 0);
