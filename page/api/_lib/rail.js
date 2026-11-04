// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Shared code for the open Radox Rail API on Stellar testnet (Vercel functions).
// Reads go through simulateTransaction (no account, no signature). The sandbox signs with
// throwaway keys derived from SANDBOX_OPERATOR_SECRET, so it keeps no state of its own:
// the chain is the database, the rate counter and the cap.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Keypair, Networks, TransactionBuilder, Operation, Address, Account, nativeToScVal, scValToNative,
  authorizeEntry, rpc, xdr,
} from "@stellar/stellar-sdk";

export const NET = Networks.TESTNET;
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON = "https://horizon-testnet.stellar.org";
export const EXPERT = "https://stellar.expert/explorer/testnet";
export const server = new rpc.Server(RPC_URL);

// custody_registry deployments on testnet, all from wasm 8230ed93…1342 (DEPLOYMENTS.md)
export const SANDBOX_REGISTRY = "CBTHLSQXQNEZ25UMVRP5TGOCPOTJXLFISJ2EF5NRNITAZPGMMW656ERX";
export const REGISTRIES = [
  { id: "CCBJVXMJYWPHTDJHDFPRGKPGXGEP24JOPJAMUS5C3BMZJTRTWR2H4LII", name: "demo" },
  { id: "CD7BUCY3DC7GTHRWFRBHNOFPMGVCHFDL4LHKXZNGEJISSGHI24KSNH3F", name: "three-machine" },
  { id: SANDBOX_REGISTRY, name: "sandbox" },
];
// placeholder token for sandbox shipments: the native XLM asset contract. The sandbox issues no token.
export const SANDBOX_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const ROLES = ["warehouse", "trucker", "ship", "customs", "buyer"];

// custody_registry on mainnet, same wasm 8230ed93 (proofs/mainnet.json). Reads only: the API never
// sends a mainnet transaction, and the sandbox stays on testnet.
export const MAINNET_REGISTRY = "CDV7YI7KYTDH4LPOLVUVRTFERJKYOWBBT6KS56ZX3V7EOGDBWS7LD4UP"; // proofs/mainnet.json

// Networks the API reads. Writes (the sandbox) are testnet only.
export const NETWORKS = {
  testnet: { name: "testnet", passphrase: NET, server, horizon: HORIZON, expert: EXPERT, registries: REGISTRIES },
  mainnet: { name: "mainnet", passphrase: Networks.PUBLIC, server: new rpc.Server("https://mainnet.sorobanrpc.com"),
    horizon: "https://horizon.stellar.org", expert: "https://stellar.expert/explorer/public",
    registries: MAINNET_REGISTRY ? [{ id: MAINNET_REGISTRY, name: "mainnet" }] : [] },
};

// the registry's own refusals (contracts/custody_registry/src/lib.rs, enum Error)
export const CONTRACT_ERRORS = {
  1: ["E_WRONG_CUSTODIAN", "The company handing over is not the one holding the shipment."],
  2: ["E_OUT_OF_ROUTE", "The receiving company is not the next stop on the route."],
  3: ["E_NOT_OPEN", "The shipment is already delivered."],
  4: ["E_DUPLICATE_KEY", "A shipment with this key already exists."],
  5: ["E_UNKNOWN_SOURCE", "This event source is not registered."],
  6: ["E_PAUSED", "The registry is paused: no writes until the admin resumes it."],
  7: ["E_FROZEN", "The shipment is frozen by the admin."],
  8: ["E_NOT_FOUND", "No shipment with this key in this registry."],
  9: ["E_BAD_ROUTE", "A route needs at least two stops, with no stop repeated next to itself."],
  10: ["E_NOT_FINAL", "Delivery needs every handover done and the last company on the route."],
  11: ["E_NOT_FROZEN", "The shipment is not frozen."],
  12: ["E_NO_PAUSER", "No emergency pauser is set."],
  13: ["E_BAD_ASSURANCE", "Assurance must be 1, 2 or 3."],
};

export const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
export const b32 = (buf) => nativeToScVal(buf, { type: "bytes" });
export const addr = (g) => nativeToScVal(g, { type: "address" });
export const u32 = (n) => nativeToScVal(n, { type: "u32" });
export const txLink = (hash, N = NETWORKS.testnet) => `${N.expert}/tx/${hash}`;
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

export class ApiError extends Error {
  constructor(status, code, message, extra = {}, network = "testnet") { super(message); Object.assign(this, { status, code, extra, network }); }
}

// a simulation or tx failure: map the registry's own Error(Contract, #n) to a named refusal
function refusal(raw) {
  const m = /Error\(Contract, #(\d+)\)/.exec(raw);
  if (m && CONTRACT_ERRORS[m[1]]) {
    const [code, message] = CONTRACT_ERRORS[m[1]];
    return new ApiError(code === "E_NOT_FOUND" ? 404 : 409, code, message,
      { refused_by: "custody_registry", contract_error: Number(m[1]) });
  }
  console.error("stellar refusal:", raw);
  if (/Error\(Auth/.test(raw)) return new ApiError(403, "E_AUTH", "A required signature is missing or invalid.", { refused_by: "stellar" });
  return new ApiError(502, "E_NETWORK", "Stellar testnet did not accept the call. Try again in a few seconds.");
}

export function parseKey(k) {
  if (typeof k !== "string" || !/^[0-9a-f]{64}$/.test(k)) {
    throw new ApiError(400, "E_KEY", "The key must be 64 lowercase hex characters (sha256 of \"<container>|<origin>\").");
  }
  return Buffer.from(k, "hex");
}

const call = (contract, fn, args) => (auth) => Operation.invokeContractFunction({ contract, function: fn, args, auth });
const hexOf = (v) => Buffer.from(v).toString("hex");

export function shapeShipment(s, registry) {
  return {
    key: hexOf(s.key),
    registry,
    status: Array.isArray(s.status) ? s.status[0] : s.status,
    current_custodian: s.current_custodian,
    route: s.route,
    seq: s.seq,
    head: hexOf(s.head),
    holder: s.holder ?? null,
    token: s.token,
  };
}

// read-only: get(key) on one registry; null when the registry has no such key
export async function getShipment(registry, key, N = NETWORKS.testnet) {
  const src = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(src, { fee: "100", networkPassphrase: N.passphrase })
    .addOperation(call(registry, "get", [b32(key)])()).setTimeout(60).build();
  const sim = await N.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    if (/Error\(Contract, #8\)/.test(sim.error)) return null;
    throw refusal(sim.error);
  }
  return shapeShipment(scValToNative(sim.result.retval), registry);
}

export async function findShipment(key, N = NETWORKS.testnet) {
  const found = await Promise.all(N.registries.map((r) => getShipment(r.id, key, N)));
  const i = found.findIndex(Boolean);
  return i < 0 ? null : { ...found[i], registry_name: N.registries[i].name };
}

let snapshot;
export function snapshotShipment(keyHex) {
  snapshot ??= JSON.parse(readFileSync(join(process.cwd(), "snapshot.json"), "utf8"));
  const p = snapshot.shipments.find((s) => s.shipment.key === keyHex);
  return p && { key: keyHex, registry: p.custody_registry, head: p.shipment.final_head };
}

async function waitFor(hash) {
  for (let i = 0; i < 40; i++) {
    const r = await server.getTransaction(hash);
    if (r.status !== "NOT_FOUND") return r;
    await sleep(1000);
  }
  throw new ApiError(504, "E_TIMEOUT", `Transaction ${hash} was sent but not seen on testnet after 40 s. Look it up on the explorer.`, { hash, explorer: txLink(hash) });
}

const credOf = (e) => e.credentials.addressV2 ?? e.credentials.address; // protocol 29 returns AddressV2

// simulate, each required address signs its own auth entry, re-simulate, send, confirm.
// Retries a bad sequence number (two visitors using the operator at the same moment).
export async function invoke(registry, fn, args, source, keys) {
  for (let attempt = 0; ; attempt++) {
    const build = async (auth) => new TransactionBuilder(await server.getAccount(source.publicKey()),
      { fee: "100000", networkPassphrase: NET }).addOperation(call(registry, fn, args)(auth)).setTimeout(60).build();
    const sim = await server.simulateTransaction(await build());
    if (rpc.Api.isSimulationError(sim)) throw refusal(sim.error);
    const until = (await server.getLatestLedger()).sequence + 60;
    const signers = [];
    const auth = await Promise.all(sim.result.auth.map((e) => {
      if (e.credentials.type === "sorobanCredentialsSourceAccount") { signers.push(source.publicKey()); return e; }
      const g = Address.fromScAddress(credOf(e).address).toString();
      signers.push(g);
      if (!keys[g]) throw new ApiError(403, "E_AUTH", `No sandbox key for required signer ${g}.`);
      return authorizeEntry(e, keys[g], until, NET);
    }));
    let tx = await build(auth);
    const sim2 = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim2)) throw refusal(sim2.error);
    tx = rpc.assembleTransaction(tx, sim2).build();
    tx.sign(source);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      if (attempt < 3 && /txBadSeq/.test(JSON.stringify(sent.errorResult))) { await sleep(500 + attempt * 700); continue; }
      throw refusal(JSON.stringify(sent.errorResult));
    }
    const r = await waitFor(sent.hash);
    if (r.status !== "SUCCESS") throw new ApiError(502, "E_TX_FAILED", `Transaction ${sent.hash} failed on testnet.`, { hash: sent.hash, explorer: txLink(sent.hash) });
    return { hash: sent.hash, explorer: txLink(sent.hash), signers };
  }
}

export async function sendClassic(source, ops) {
  for (let attempt = 0; ; attempt++) {
    const b = new TransactionBuilder(await server.getAccount(source.publicKey()), { fee: "10000", networkPassphrase: NET }).setTimeout(60);
    ops.forEach((o) => b.addOperation(o));
    const tx = b.build();
    tx.sign(source);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      if (attempt < 3 && /txBadSeq/.test(JSON.stringify(sent.errorResult))) { await sleep(500 + attempt * 700); continue; }
      throw new ApiError(502, "E_NETWORK", "Stellar testnet did not accept the account setup. Try again in a few seconds.");
    }
    const r = await waitFor(sent.hash);
    if (r.status !== "SUCCESS") throw new ApiError(502, "E_TX_FAILED", `Setup transaction ${sent.hash} failed.`, { hash: sent.hash });
    return { hash: sent.hash, explorer: txLink(sent.hash) };
  }
}

// --- sandbox keys and limits ----------------------------------------------------------------
export function operatorKey() {
  const s = process.env.SANDBOX_OPERATOR_SECRET;
  if (!s) throw new ApiError(503, "E_SANDBOX_OFF", "The sandbox is not configured on this deployment.");
  return Keypair.fromSecret(s);
}

// one throwaway key per (shipment, role), derived so no key is ever stored
export function sandboxKeys(keyHex) {
  const op = operatorKey();
  const k = (role) => Keypair.fromRawEd25519Seed(createHmac("sha256", op.rawSecretKey()).update(`rail-sandbox|${keyHex}|${role}`).digest());
  const stops = ROLES.map(k);
  return { op, stops, holder: k("holder") };
}

// per-IP, per instance: a best-effort burst limit (ponytail: in memory; a shared store if abuse spreads across instances)
const hits = new Map();
export function limitIp(req, bucket, max, windowMs) {
  const ip = String(req.headers["x-vercel-forwarded-for"] ?? req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const k = `${bucket}|${ip}`;
  const list = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) throw new ApiError(429, "E_RATE_LIMIT", `Too many calls from your address. Wait ${Math.ceil(windowMs / 60000)} minutes and try again.`);
  list.push(now);
  hits.set(k, list);
}

// global cap, counted on the chain itself: every sandbox shipment costs the operator two transactions
// ponytail: check-then-spend, a burst of parallel opens can pass it by the opens in flight; the per-IP
// limit and the balance floor bound that. An atomic counter (KV INCR) if it ever matters.
export const OPENS_PER_HOUR = 20;
const MIN_BALANCE_XLM = 2000; // a reserve no stranger can spend: ~24 h of the cap stays covered
// Only transactions the operator sent count: Horizon also lists payments anyone sends to the account,
// and those must not let a stranger close the sandbox. Pages past incoming spam until an hour back.
// ponytail: stops after 5 pages (1,000 transactions) and lets the open through; the per-IP limit and
// the balance floor still bound a spammer who hides our own transactions that deep.
export async function checkCap(op) {
  const me = op.publicKey(), since = Date.now() - 3600_000;
  let own = 0, cursor = "";
  for (let page = 0; page < 5 && own < OPENS_PER_HOUR * 2; page++) {
    const r = await fetch(`${HORIZON}/accounts/${me}/transactions?order=desc&limit=200${cursor && `&cursor=${cursor}`}`);
    if (!r.ok) throw new ApiError(502, "E_NETWORK", "Could not read the sandbox account on testnet. Try again in a few seconds.");
    const recs = (await r.json())._embedded.records;
    const recent = recs.filter((t) => Date.parse(t.created_at) > since);
    own += recent.filter((t) => t.source_account === me).length;
    if (recent.length < recs.length || recs.length < 200) break;
    cursor = recs.at(-1).paging_token;
  }
  if (own >= OPENS_PER_HOUR * 2) throw new ApiError(429, "E_SANDBOX_CAP", `The sandbox opens at most ${OPENS_PER_HOUR} shipments an hour for everyone. Try again later, or read an existing shipment.`);
  const acct = await (await fetch(`${HORIZON}/accounts/${op.publicKey()}`)).json();
  const xlm = Number(acct.balances?.find((b) => b.asset_type === "native")?.balance ?? 0);
  if (xlm < MIN_BALANCE_XLM) throw new ApiError(503, "E_SANDBOX_EMPTY", "The sandbox account is low on testnet XLM. Read an existing shipment instead.");
}

// --- history and head check ---------------------------------------------------------------------
const addrBytes = (g) => Buffer.from(addr(g).toXDR());
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
export const headOpen = (key, docsRoot) => sha([0x01], key, docsRoot);
export const headHandover = (head, from, to, ev, seq, a) => sha([0x02], head, addrBytes(from), addrBytes(to), ev, be32(seq), be32(a));
export const headAttest = (head, src, kind, ev, seq) => sha([0x03], head, addrBytes(src), be32(kind), ev, be32(seq));

// The registry's successful calls for this key: tx hashes from contract events (the RPC keeps them
// about 7 days), arguments from Horizon. Recomputes the head step by step, as scripts/verify-head.mjs.
export async function history(registry, key, N = NETWORKS.testnet) {
  const { server, horizon } = N;
  const latest = (await server.getLatestLedger()).sequence;
  const keyTopic = b32(key).toXDR("base64");
  const hashes = new Set();
  // each getEvents call scans a window of about 10 000 ledgers and returns a cursor to go on
  let cursor;
  for (let page = 0; page < 16; page++) {
    const q = cursor ? { cursor } : { startLedger: Math.max(latest - 119_000, 1) };
    const args = { ...q, filters: [{ type: "contract", contractIds: [registry], topics: [["*", keyTopic]] }], limit: 100 };
    // the public RPC answers an occasional 502 right after a write: try again once
    const ev = await server.getEvents(args).catch(async () => { await sleep(1500); return server.getEvents(args); });
    ev.events.forEach((e) => hashes.add(e.txHash));
    cursor = ev.cursor;
    if (!cursor || Number(BigInt(cursor.split("-")[0]) >> 32n) >= latest) break;
  }
  const steps = [];
  for (const h of hashes) {
    const [tr, or] = await Promise.all([fetch(`${horizon}/transactions/${h}`), fetch(`${horizon}/transactions/${h}/operations`)]);
    if (!tr.ok || !or.ok) throw new ApiError(502, "E_NETWORK", `Horizon (Stellar ${N.name} history) is busy. Try again in a few seconds.`);
    const t = await tr.json(), ops = await or.json();
    for (const op of ops._embedded.records) {
      if (op.type !== "invoke_host_function" || !op.parameters) continue;
      const v = op.parameters.map((p) => scValToNative(xdr.ScVal.fromXDR(p.value, "base64")));
      if (v[0] !== registry || hexOf(v[2]) !== key.toString("hex")) continue;
      steps.push({ fn: v[1], args: v.slice(2), hash: h, explorer: txLink(h, N), ledger: t.ledger, time: t.created_at, paging: BigInt(op.paging_token) });
    }
  }
  steps.sort((a, b) => a.ledger - b.ledger || (a.paging < b.paging ? -1 : 1));
  let head = null, seq = 0;
  const out = steps.map(({ fn, args: a, hash, explorer, ledger, time }) => {
    const s = { step: fn, hash, explorer, ledger, time };
    if (fn === "open") { head = headOpen(a[0], a[3]); seq = 0; s.route = a[2]; s.docs_root = hexOf(a[3]); }
    else if (fn === "handover") { seq += 1; head = headHandover(head, a[1], a[2], a[3], seq, a[4]); Object.assign(s, { from: a[1], to: a[2], seq, evidence_hash: hexOf(a[3]), assurance: a[4] }); }
    else if (fn === "attest") { head = headAttest(head, a[1], a[2], a[3], seq); Object.assign(s, { source: a[1], kind: a[2] }); }
    else if (fn === "deliver") Object.assign(s, { final_custodian: a[1], holder: a[2] });
    if (head) s.head_after = head.toString("hex");
    return s;
  });
  return { steps: out, recomputed_head: head && head.toString("hex") };
}

// --- HTTP ---------------------------------------------------------------------------------------
// opts.mainnet: the endpoint reads mainnet too; without it ?network=mainnet is refused (the sandbox writes)
export function handler(methods, fn, opts = {}) {
  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", `${methods.join(", ")}, OPTIONS`);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(204).end();
    let network = "testnet";
    try {
      if (!methods.includes(req.method)) throw new ApiError(405, "E_METHOD", `Use ${methods.join(" or ")}.`);
      if (req.query.network !== undefined && !Object.hasOwn(NETWORKS, req.query.network)) throw new ApiError(400, "E_NETWORK_PARAM", "\"network\" must be testnet or mainnet.");
      network = req.query.network ?? "testnet";
      const N = NETWORKS[network];
      if (network === "mainnet" && !opts.mainnet) throw new ApiError(400, "E_TESTNET_ONLY", "The sandbox runs on testnet only. Leave out network, or use network=testnet.");
      if (!N.registries.length) throw new ApiError(503, "E_MAINNET_NOT_DEPLOYED", "The mainnet registry is not deployed yet. Use network=testnet (the default).");
      const [status, body] = await fn(req, N);
      res.status(status).json({ network, ...body });
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(502, "E_NETWORK", `Stellar ${network} could not be reached. Try again in a few seconds.`);
      if (!(e instanceof ApiError)) console.error(e);
      res.status(err.status).json({ network, error: { code: err.code, message: err.message, ...err.extra } });
    }
  };
}
