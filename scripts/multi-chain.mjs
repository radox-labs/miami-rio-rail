// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Many supply chains, one rail: two companies' custody chains on one custody_registry, run on
// Stellar testnet with fresh test keys and the existing contract code (no new contract).
//   Shipment 1: A-warehouse -> A-terminal (internal to company A) -> B-vessel (external, A to B)
//               -> B-depot (internal to company B), then delivered to its holder.
//   Shipment 2: A-yard -> A-terminal (internal) -> B-vessel (external), delivered at B-vessel.
//               It shares the A-terminal and B-vessel stops with shipment 1; each keeps its own head.
// The registry sees only addresses. Which company and unit an address belongs to is the
// off-chain directory in proofs/multi-chain.json, not a contract field.
// No token moves: `token` is only recorded (the registry never calls it). No money flow.
//   node scripts/multi-chain.mjs   -> proofs/multi-chain.json and proofs/tx/*.json
// Needs the registry wasm installed on testnet (REGISTRY_WASM_HASH); after a testnet reset, upload
// contracts/custody_registry's wasm again with `stellar contract upload` and pass its hash.
import { createHash, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, Operation, nativeToScVal } from "@stellar/stellar-sdk";
import { HORIZON, addr, sleep, fund, invokeOp, call, read, random } from "./lib/stellar.mjs";
import { wasmHash } from "./lib/contracts-lock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_WASM = process.env.REGISTRY_WASM_HASH ?? wasmHash("custody_registry");
const TOKEN = "CBCWTIT5YNPNSA4ZSJJXUFZKGQROZPWNWYNZ4CSO7HLWJXU7Z6N5Q22Z"; // the demo's cargo token, recorded only

const sha = (s) => createHash("sha256").update(s).digest();
const b32 = (buf) => nativeToScVal(buf, { type: "bytes" });
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const admin = random();
const operator = random();
const units = {
  "A-warehouse": random(), "A-terminal": random(), "A-yard": random(),
  "B-vessel": random(), "B-depot": random(),
};
const holder1 = random();
const holder2 = random();
const all = { admin, operator, ...units, holder1, holder2 };
const keys = Object.fromEntries(Object.values(all).map((k) => [k.publicKey(), k]));
const nameOf = (g) => Object.entries(all).find(([, k]) => k.publicKey() === g)?.[0] ?? g;
const companyOf = (n) => (n.startsWith("A-") ? "Company A" : n.startsWith("B-") ? "Company B" : null);

const run = String(randomInt(0, 1e7)).padStart(7, "0");
const shipments = [
  { container: `TEST${run}`, route: ["A-warehouse", "A-terminal", "B-vessel", "B-depot"], holder: "holder1" },
  { container: `TEST${String((Number(run) + 1) % 1e7).padStart(7, "0")}`, route: ["A-yard", "A-terminal", "B-vessel"], holder: "holder2" },
].map((s) => ({ ...s, origin: "BRRIO", key: sha(`${s.container}|BRRIO`), docsRoot: sha(`docs|${s.container}|TEST`) }));

const proof = {
  network: "testnet",
  custody_registry: null,
  token: TOKEN,
  directory: Object.fromEntries(Object.entries(units).map(([n, k]) => [k.publicKey(), { company: companyOf(n), unit: n }])),
  actors: Object.fromEntries(Object.entries(all).map(([n, k]) => [n, k.publicKey()])),
  shipment: null, // shipment 1, for verify-head --offline
  shipments: [],
  setup: [], lifecycle: [], attest: [],
};

async function mustInvoke(label, op, signer = operator) {
  const r = await invokeOp(op, signer, keys);
  if (r.simError || r.status !== "SUCCESS") throw new Error(`${label}: ${r.simError ?? r.status} (auth ${r.auth})`);
  log(label, r.hash, `auth: ${r.auth.map(nameOf).join(" + ")}`);
  return r;
}

async function horizonSave(hash) {
  const dir = join(ROOT, "proofs", "tx");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 30; i++) {
    const t = await fetch(`${HORIZON}/transactions/${hash}`);
    if (t.ok) {
      const ops = await (await fetch(`${HORIZON}/transactions/${hash}/operations`)).json();
      writeFileSync(join(dir, `${hash}.json`), JSON.stringify({ transaction: await t.json(), operations: ops }, null, 2) + "\n");
      return;
    }
    await sleep(2000);
  }
  throw new Error(`Horizon has no ${hash}`);
}

// --- run ----------------------------------------------------------------------------------
await Promise.all(Object.values(all).map(fund));
const d = await mustInvoke("deploy custody_registry", (auth) => Operation.createCustomContract({
  address: new Address(admin.publicKey()), wasmHash: Buffer.from(REGISTRY_WASM, "hex"),
  constructorArgs: [addr(admin.publicKey()), addr(operator.publicKey())], salt: sha(`multi-chain|${run}`), auth,
}), admin);
const registry = d.result;
proof.custody_registry = registry;
proof.setup.push({ step: "custody_registry_deploy", hash: d.hash });

const step = (s, hash, extra = {}) => { proof.lifecycle.push({ shipment: s.container, step: extra.step ?? "?", hash, ...extra }); };
for (const s of shipments) {
  const route = nativeToScVal(s.route.map((n) => new Address(units[n].publicKey())));
  step(s, (await mustInvoke(`open ${s.container}`, call(registry, "open", [b32(s.key), addr(TOKEN), route, b32(s.docsRoot)]))).hash, { step: "open" });
}
// interleave the two shipments, so the shared stops hold both at the same time
const plan = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]];
for (const [si, i] of plan) {
  const s = shipments[si];
  const from = s.route[i], to = s.route[i + 1];
  const kind = companyOf(from) === companyOf(to) ? "internal" : "external";
  const r = await mustInvoke(`handover ${s.container} ${from} -> ${to} (${kind})`, call(registry, "handover",
    [b32(s.key), addr(units[from].publicKey()), addr(units[to].publicKey()), b32(sha(`handover-${i + 1}|${s.container}`)), u32(3)]));
  step(s, r.hash, { step: "handover", from, to, kind });
}
for (const s of shipments) {
  const last = s.route.at(-1);
  step(s, (await mustInvoke(`deliver ${s.container}`, call(registry, "deliver",
    [b32(s.key), addr(units[last].publicKey()), addr(all[s.holder].publicKey())]))).hash, { step: "deliver" });
}
for (const s of shipments) {
  const head = Buffer.from(await read(registry, "head", [b32(s.key)], operator)).toString("hex");
  proof.shipments.push({ container: s.container, origin: s.origin, key: s.key.toString("hex"), docs_root: s.docsRoot.toString("hex"),
    route: s.route.map((n) => units[n].publicKey()), route_units: s.route, holder: all[s.holder].publicKey(), final_head: head });
  log(`final head ${s.container}`, head);
}
proof.shipment = proof.shipments[0];
for (const h of [proof.setup[0].hash, ...proof.lifecycle.map((x) => x.hash)]) await horizonSave(h);
writeFileSync(join(ROOT, "proofs", "multi-chain.json"), JSON.stringify(proof, null, 2) + "\n");
log(`done: registry ${registry}, ${proof.lifecycle.length} transactions -> proofs/multi-chain.json`);
