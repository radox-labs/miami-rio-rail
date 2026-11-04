// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Mainnet rehearsal on a LOCAL fork (soroban-sim serve --fork mainnet). Nothing reaches the network.
// Same registry WASM bytes as testnet (fetched by hash), same lifecycle and failure branches as
// scripts/lifecycle.mjs, minus the token steps (transfer_agent is not on mainnet).
//
//   RPC_URL=http://127.0.0.1:8000 NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015" \
//     node scripts/mainnet-rehearsal.mjs
import { createHash, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, Address, Networks, Operation, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { RPC_URL, NET, addr, invokeOp, call, read, random } from "./lib/stellar.mjs";

if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC_URL) || NET !== Networks.PUBLIC)
  throw new Error("rehearsal runs only against a local mainnet fork (RPC_URL on localhost, PUBLIC passphrase)");
const fork = async (method, params = {}) => {
  const r = await (await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
await fork("fork_info"); // a real RPC has no fork_* methods: stop here if this is not the fork

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM_HASH = "8230ed937f443e40054d0806c9cdd044ef341db19f0c1b3123c573adb7a41342"; // the testnet-proven build
const sha = (s) => createHash("sha256").update(s).digest();
const b32 = (b) => nativeToScVal(b, { type: "bytes" });
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const testnet = new rpc.Server("https://soroban-testnet.stellar.org");
const code = await testnet.getLedgerEntries(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(WASM_HASH, "hex") })));
const wasm = Buffer.from(code.entries[0].val.contractCode.code);
if (sha(wasm).toString("hex") !== WASM_HASH) throw new Error("wasm from testnet does not match its hash");

const exporter = random(), operator = random(), holder = random(), source = random(), stranger = random();
const route = { warehouse: random(), port: random(), carrier: random(), customs: random(), recipient: random() };
const all = { exporter, operator, holder, ...route, source, stranger };
const keys = Object.fromEntries(Object.values(all).map((k) => [k.publicKey(), k]));
const stops = Object.values(route);
const routeArg = () => nativeToScVal(stops.map((k) => new Address(k.publicKey())));
const nameOf = (g) => Object.entries(all).find(([, k]) => k.publicKey() === g)?.[0] ?? g;
const token = Asset.native().contractId(Networks.PUBLIC); // stored only, never called by the registry

const container = `TEST${String(randomInt(0, 1e7)).padStart(7, "0")}`;
const key = sha(`${container}|BRRIO`);
const docsRoot = sha(`docs|${container}|bill-of-lading-TEST|invoice-TEST|packing-list-TEST`);
const proof = { network: "mainnet fork (local, soroban-sim)", wasm_hash: WASM_HASH, steps: [], failures: [] };

async function must(label, op, signer = operator) {
  const r = await invokeOp(op, signer, keys);
  if (r.simError || r.status !== "SUCCESS") throw new Error(`${label}: ${r.simError ?? r.status}`);
  proof.steps.push({ step: label, hash: r.hash, auth: r.auth.map(nameOf) });
  log(label, r.hash, r.auth.map(nameOf).join(" + "));
  return r;
}
async function refuse(kase, op, signer = operator, signKeys = keys) {
  const r = await invokeOp(op, signer, signKeys);
  if (!(r.simError || r.status !== "SUCCESS")) throw new Error(`${kase}: expected a refusal, got ${r.hash}`);
  proof.failures.push({ case: kase, error: r.simError ?? r.status });
  log("refused", kase, r.simError ?? r.status);
}

const START_XLM = 100;
for (const [n, k] of Object.entries(all)) await fork("fork_setBalance", { account: k.publicKey(), xlm: START_XLM, label: n });

await must("upload_wasm", () => Operation.uploadContractWasm({ wasm }), exporter);
const dep = await must("deploy", (auth) => Operation.createCustomContract({ address: new Address(exporter.publicKey()),
  wasmHash: Buffer.from(WASM_HASH, "hex"), constructorArgs: [addr(exporter.publicKey()), addr(operator.publicKey())],
  salt: sha(container), auth }), exporter);
const reg = dep.result;
proof.custody_registry = reg;
await must("add_source", call(reg, "add_source", [addr(source.publicKey())]), exporter);
await must("open", call(reg, "open", [b32(key), addr(token), routeArg(), b32(docsRoot)]));

const [w, p, c, , rc] = stops;
const ev = (i) => sha(`handover-${i}|${container}`);
await refuse("wrong_custodian", call(reg, "handover", [b32(key), addr(p.publicKey()), addr(c.publicKey()), b32(ev(9)), u32(3)]));
await refuse("out_of_route", call(reg, "handover", [b32(key), addr(w.publicKey()), addr(c.publicKey()), b32(ev(9)), u32(3)]));
await refuse("wrong_signer", call(reg, "handover", [b32(key), addr(w.publicKey()), addr(p.publicKey()), b32(ev(9)), u32(3)]),
  operator, { ...keys, [p.publicKey()]: stranger });
await refuse("early_delivery", call(reg, "deliver", [b32(key), addr(rc.publicKey()), addr(holder.publicKey())]));
await refuse("bad_assurance", call(reg, "handover", [b32(key), addr(w.publicKey()), addr(p.publicKey()), b32(ev(9)), u32(0)]));

for (let i = 0; i < 4; i++) {
  await must(`handover_${i + 1}`, call(reg, "handover",
    [b32(key), addr(stops[i].publicKey()), addr(stops[i + 1].publicKey()), b32(ev(i + 1)), u32(3)]));
  if (i === 1) await must("attest", call(reg, "attest", [b32(key), addr(source.publicKey()), u32(1), b32(sha(`gate-in|${container}`))]));
}
await must("deliver", call(reg, "deliver", [b32(key), addr(rc.publicKey()), addr(holder.publicKey())]));
const shipment = await read(reg, "get", [b32(key)], operator);
proof.final_status = Array.isArray(shipment.status) ? shipment.status[0] : shipment.status;
proof.final_head = Buffer.from(await read(reg, "head", [b32(key)], operator)).toString("hex");
if (proof.final_status !== "Delivered") throw new Error(`final status ${proof.final_status}`);

const key2 = sha(`TEST${String(randomInt(0, 1e7)).padStart(7, "0")}|BRRIO`);
await must("open_second", call(reg, "open", [b32(key2), addr(token), routeArg(), b32(docsRoot)]));
await refuse("duplicate_key", call(reg, "open", [b32(key), addr(token), routeArg(), b32(docsRoot)]));
await must("freeze", call(reg, "freeze", [b32(key2)]), exporter);
await refuse("after_freeze", call(reg, "handover", [b32(key2), addr(w.publicKey()), addr(p.publicKey()), b32(ev(1)), u32(3)]));
await must("unfreeze", call(reg, "unfreeze", [b32(key2)]), exporter);
await must("pause", call(reg, "pause", []), exporter);
await refuse("while_paused", call(reg, "handover", [b32(key2), addr(w.publicKey()), addr(p.publicKey()), b32(ev(1)), u32(3)]));
await must("resume", call(reg, "resume", []), exporter);
await refuse("unknown_source", call(reg, "attest", [b32(key2), addr(stranger.publicKey()), u32(1), b32(ev(1))]));

proof.report = await fork("fork_report");
mkdirSync(join(ROOT, "proofs"), { recursive: true });
writeFileSync(join(ROOT, "proofs", "mainnet-rehearsal.json"), JSON.stringify(proof, null, 2) + "\n");
log(`done: ${proof.steps.length} transactions, ${proof.failures.length} refusals, status ${proof.final_status} -> proofs/mainnet-rehearsal.json`);
