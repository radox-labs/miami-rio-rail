// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Testnet harness: one shipment from warehouse to recipient, every handover signed by both
// custodians, then delivery and the token burn through the asset's transfer agent.
// Writes proofs/lifecycle.json and proofs/tx/<hash>.json. Test keys only, generated per run.
//
//   node scripts/lifecycle.mjs
// Optional env: REGISTRY (an existing custody_registry) with EXPORTER_SECRET (its admin) and
// OPERATOR_SECRET (its operator); without them the harness deploys its own registry.
import { createHash, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Keypair, Asset, Operation, Address, Networks, AuthRequiredFlag, AuthRevocableFlag, AuthClawbackEnabledFlag,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { HORIZON, server, addr, sleep, fund, sendClassic, invokeOp, call, read, random } from "./lib/stellar.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_WASM = process.env.REGISTRY_WASM_HASH ?? "8230ed937f443e40054d0806c9cdd044ef341db19f0c1b3123c573adb7a41342";
// External Radox interfaces (closed source — part of Radox's prior startup implementations
// built before HackMeridian; not public because they belong to the startup's proprietary
// platform backend and regulated token-issuance/settlement money path):
//
// 1. On-chain Soroban contract `transfer_agent` (WASM hash below, deployed as-is on testnet):
//    - __constructor(config: { admin: Address, operator: Address })
//        Initializes the transfer agent for an asset issuer (`admin`) and rail operator (`operator`).
//    - register_token(token: Address, seller: Address, settlement: Address, payment_asset: Address)
//        Registers the Stellar Asset Contract (`token`) with its seller, settlement account and
//        payment asset. Requires `operator` authorization.
//    - mint(token: Address, to: Address, amount: i128)
//        Mints `amount` of the registered SAC token to `to` (seller). Requires `operator` auth.
//    - deliver(token: Address, to: Address, amount: i128)
//        Delivers `amount` of the SAC token to the buyer/holder (`to`). Requires `operator` auth.
//    - redeem(token: Address, from: Address, amount: i128, ref_id: u64)
//        Burns `amount` of the SAC token from `from` (holder) via SAC clawback/burn after the
//        shipment reaches `Delivered` in `custody_registry`. Requires `operator` auth.
//
// 2. Off-chain Radox platform REST API (`GET /api/custody/shipments/:key` in Radox's closed backend):
//    - Comes from Radox's closed backend;
//      not public because it is part of the startup's pre-existing proprietary backend implementation.
//    - Input: `:key` (64-character hex string = sha256("<container>|<origin>")).
//    - Behavior: read-only Soroban RPC `simulateTransaction` calling `custody_registry.get(key)`.
//    - Output (200 OK): `{ success: true, data: { key, contract, status, currentCustodian, route, seq, head, holder } }`
//    - Errors: `400 E_CUSTODY_KEY` (invalid key format), `404 E_CUSTODY_NOT_FOUND` (unknown key).
const AGENT_WASM = "3870748b709f7b8531c7ebbbc975712333f61949831350ff7192f7076fc6bff1"; // prior work, deployed as-is
const AMOUNT = 10000000n; // 1.0000000 of a 7-decimal asset
const REF_ID = 1n;

const sha = (s) => createHash("sha256").update(s).digest();
const b32 = (buf) => nativeToScVal(buf, { type: "bytes" });
const i128 = (n) => nativeToScVal(n, { type: "i128" });
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const u64 = (n) => nativeToScVal(n, { type: "u64" });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --- actors -------------------------------------------------------------------------------
const fromEnv = (v) => (process.env[v] ? Keypair.fromSecret(process.env[v]) : null);
const exporter = fromEnv("EXPORTER_SECRET") ?? random(); // issuer, transfer-agent admin, registry admin
const operator = fromEnv("OPERATOR_SECRET") ?? random(); // rail operator
const seller = random();
const holder = random(); // token holder: owns the goods in transit
const route = { warehouse: random(), port: random(), carrier: random(), customs: random(), recipient: random() };
const source = random(); // event source for attest
const stranger = random();
const all = { exporter, operator, seller, holder, ...route, source, stranger };
const keys = Object.fromEntries(Object.values(all).map((k) => [k.publicKey(), k]));
const stops = Object.values(route);
const routeArg = () => nativeToScVal(stops.map((k) => new Address(k.publicKey())));

// made-up identifiers only; a fresh container number per run keeps the key unique
const container = `TEST${String(randomInt(0, 1e7)).padStart(7, "0")}`;
const origin = "BRRIO";
const key = sha(`${container}|${origin}`);
const docsRoot = sha(`docs|${container}|bill-of-lading-TEST|invoice-TEST|packing-list-TEST`);
const asset = new Asset("RMR1", exporter.publicKey());

const proof = {
  network: "testnet",
  custody_registry: null, transfer_agent_instance: null, token: null,
  shipment: { container, origin, key: key.toString("hex"), docs_root: docsRoot.toString("hex") },
  actors: Object.fromEntries(Object.entries(all).map(([n, k]) => [n, k.publicKey()])),
  setup: [], lifecycle: [], attest: [], failures: [],
};
const setupStep = (step, hash, extra = {}) => { proof.setup.push({ step, hash, ...extra }); log("setup", step, hash ?? ""); };

async function mustInvoke(label, op, signer = operator) {
  const r = await invokeOp(op, signer, keys);
  if (r.simError || r.status !== "SUCCESS") throw new Error(`${label}: ${r.simError ?? r.status} (auth ${r.auth})`);
  log(label, r.hash, `auth: ${r.auth.map((g) => nameOf(g)).join(" + ")}`);
  return r;
}
const nameOf = (g) => Object.entries(all).find(([, k]) => k.publicKey() === g)?.[0] ?? g;

async function deploy(label, wasmHex, ctorArgs) {
  const op = (auth) => Operation.createCustomContract({
    address: new Address(exporter.publicKey()), wasmHash: Buffer.from(wasmHex, "hex"),
    constructorArgs: ctorArgs, salt: sha(`${label}|${container}`), auth,
  });
  const r = await mustInvoke(`deploy ${label}`, op, exporter);
  return { id: r.result, hash: r.hash };
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

// a failure branch: expect a refusal, record the error (simulation) or the failed tx
async function expectRefusal(kase, op, signer, signKeys = keys) {
  const r = await invokeOp(op, signer, signKeys);
  const ok = r.simError || (r.status && r.status !== "SUCCESS");
  if (!ok) throw new Error(`${kase}: expected a refusal, got ${r.status} ${r.hash}`);
  const error = r.simError ?? r.status;
  proof.failures.push({ case: kase, error, hash_or_sim: r.hash ?? "simulation" });
  log("refused", kase, error);
}

// --- run ----------------------------------------------------------------------------------
log(`shipment ${container}|${origin} key ${key.toString("hex")}`);
await Promise.all(Object.values(all).map(fund));
setupStep("friendbot_fund", null, { accounts: Object.keys(all) });

// issuer flags before any trustline: a trustline made before clawback is on breaks redeem (SAC #10)
setupStep("issuer_flags", await sendClassic(exporter, [Operation.setOptions({
  setFlags: AuthRequiredFlag | AuthRevocableFlag | AuthClawbackEnabledFlag })]));
for (const [n, k] of [["seller", seller], ["holder", holder]]) {
  setupStep(`trustline_${n}`, await sendClassic(k, [Operation.changeTrust({ asset })]));
  setupStep(`authorize_${n}`, await sendClassic(exporter, [Operation.setTrustLineFlags({
    trustor: k.publicKey(), asset, flags: { authorized: true } })]));
}
const sacR = await mustInvoke("deploy asset contract", (auth) => Operation.createStellarAssetContract({ asset, auth }), exporter);
const token = sacR.result;
proof.token = token;
setupStep("asset_contract", sacR.hash);

const agent = await deploy("transfer_agent", AGENT_WASM, [nativeToScVal(
  { admin: new Address(exporter.publicKey()), operator: new Address(operator.publicKey()) }, { type: { admin: ["symbol", null], operator: ["symbol", null] } })]);
proof.transfer_agent_instance = agent.id;
setupStep("transfer_agent_deploy", agent.hash);

let registry = process.env.REGISTRY;
if (!registry) {
  const d = await deploy("custody_registry", REGISTRY_WASM, [addr(exporter.publicKey()), addr(operator.publicKey())]);
  registry = d.id;
  setupStep("custody_registry_deploy", d.hash);
}
proof.custody_registry = registry;

setupStep("set_admin_to_agent", (await mustInvoke("sac.set_admin", call(token, "set_admin", [addr(agent.id)]), exporter)).hash);
const acct = await (await fetch(`${HORIZON}/accounts/${exporter.publicKey()}`)).json();
proof.issuer_after_set_admin = { thresholds: acct.thresholds, master_weight: acct.signers?.find((s) => s.key === exporter.publicKey())?.weight };
const xlm = Asset.native().contractId(Networks.TESTNET);
setupStep("register_token", (await mustInvoke("register_token", call(agent.id, "register_token",
  [addr(token), addr(seller.publicKey()), addr(exporter.publicKey()), addr(xlm)]))).hash);
setupStep("mint", (await mustInvoke("mint", call(agent.id, "mint", [addr(token), addr(seller.publicKey()), i128(AMOUNT)]))).hash);
setupStep("agent_deliver_to_holder", (await mustInvoke("transfer_agent.deliver", call(agent.id, "deliver",
  [addr(token), addr(holder.publicKey()), i128(AMOUNT)]))).hash);
setupStep("add_event_source", (await mustInvoke("add_source", call(registry, "add_source", [addr(source.publicKey())]), exporter)).hash);

// --- the 7 that count ---------------------------------------------------------------------
const lc = (step, hash) => proof.lifecycle.push({ step, hash });
lc("open", (await mustInvoke("open", call(registry, "open",
  [b32(key), addr(token), routeArg(), b32(docsRoot)]))).hash);

// failure branches that need the open shipment (simulations: state does not change)
const [w, p, c, cu, rc] = stops;
const ev = (i) => sha(`handover-${i}|${container}`);
await expectRefusal("wrong_custodian", call(registry, "handover", [b32(key), addr(p.publicKey()), addr(c.publicKey()), b32(ev(9)), u32(3)]), operator);
await expectRefusal("out_of_route", call(registry, "handover", [b32(key), addr(w.publicKey()), addr(c.publicKey()), b32(ev(9)), u32(3)]), operator);
await expectRefusal("wrong_signer", call(registry, "handover", [b32(key), addr(w.publicKey()), addr(p.publicKey()), b32(ev(9)), u32(3)]),
  operator, { ...keys, [p.publicKey()]: stranger }); // the incoming custodian's entry signed by someone else
await expectRefusal("early_delivery", call(registry, "deliver", [b32(key), addr(rc.publicKey()), addr(holder.publicKey())]), operator);
await expectRefusal("bad_assurance", call(registry, "handover", [b32(key), addr(w.publicKey()), addr(p.publicKey()), b32(ev(9)), u32(0)]), operator);

for (let i = 0; i < 4; i++) {
  lc("handover", (await mustInvoke(`handover ${i + 1}`, call(registry, "handover",
    [b32(key), addr(stops[i].publicKey()), addr(stops[i + 1].publicKey()), b32(ev(i + 1)), u32(3)]))).hash);
  if (i === 1) { // a port gate-in event from the registered source
    const r = await mustInvoke("attest", call(registry, "attest",
      [b32(key), addr(source.publicKey()), u32(1), b32(sha(`gate-in|${container}`))]));
    proof.attest.push({ hash: r.hash });
  }
}
lc("deliver", (await mustInvoke("deliver", call(registry, "deliver", [b32(key), addr(rc.publicKey()), addr(holder.publicKey())]))).hash);
proof.shipment.final_head = Buffer.from(await read(registry, "head", [b32(key)], operator)).toString("hex");

const shipment = await read(registry, "get", [b32(key)], operator);
const status = Array.isArray(shipment.status) ? shipment.status[0] : shipment.status;
if (status !== "Delivered") throw new Error(`redeem precondition: registry says ${status}, not Delivered`);
proof.redeem_precondition = "Delivered";
lc("redeem", (await mustInvoke("redeem", call(agent.id, "redeem",
  [addr(token), addr(holder.publicKey()), i128(AMOUNT), u64(REF_ID)]))).hash);
proof.holder_balance_after_redeem = String(await read(token, "balance", [addr(holder.publicKey())], operator));
log("holder balance after redeem", proof.holder_balance_after_redeem);

// --- failure branches on a second shipment and on the whole registry ------------------------
const key2 = sha(`TEST${String(randomInt(0, 1e7)).padStart(7, "0")}|${origin}`);
await mustInvoke("open (second shipment)", call(registry, "open", [b32(key2), addr(token), routeArg(), b32(docsRoot)]));
await expectRefusal("duplicate_key", call(registry, "open", [b32(key), addr(token), routeArg(), b32(docsRoot)]), operator);
const fz = await mustInvoke("freeze", call(registry, "freeze", [b32(key2)]), exporter);
await expectRefusal("after_freeze", call(registry, "handover", [b32(key2), addr(w.publicKey()), addr(p.publicKey()), b32(ev(1)), u32(3)]), operator);
const ufz = await mustInvoke("unfreeze", call(registry, "unfreeze", [b32(key2)]), exporter);
const ps = await mustInvoke("pause", call(registry, "pause", []), exporter);
await expectRefusal("while_paused", call(registry, "handover", [b32(key2), addr(w.publicKey()), addr(p.publicKey()), b32(ev(1)), u32(3)]), operator);
const rs = await mustInvoke("resume", call(registry, "resume", []), exporter);
await expectRefusal("unknown_source", call(registry, "attest", [b32(key2), addr(stranger.publicKey()), u32(1), b32(ev(1))]), operator);
proof.failure_context = { second_shipment_key: key2.toString("hex"), freeze: fz.hash, unfreeze: ufz.hash, pause: ps.hash, resume: rs.hash };

// --- save ---------------------------------------------------------------------------------
for (const h of [...proof.lifecycle.map((x) => x.hash), ...proof.attest.map((x) => x.hash)]) await horizonSave(h);
mkdirSync(join(ROOT, "proofs"), { recursive: true });
writeFileSync(join(ROOT, "proofs", "lifecycle.json"), JSON.stringify(proof, null, 2) + "\n");
log(`done: ${proof.lifecycle.length} lifecycle hashes, ${proof.failures.length} failure branches -> proofs/lifecycle.json`);
