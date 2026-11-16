// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Mainnet deploy of custody_registry (wasm 8230ed93, the testnet-proven build, fetched by hash) and one
// shipment: open, 4 dual-signed handovers, deliver. No token, no transfer_agent: the registry only
// stores the token address. Admin and operator are two keys, read from env, never from git.
//
//   set -a; . ~/.config/radox-rail/mainnet.env; set +a
//   NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015" RPC_URL=https://mainnet.sorobanrpc.com \
//     ADMIN_LEDGER=G... ADMIN_LEDGER_HD=10 CONFIRM_MAINNET=send node scripts/mainnet-deploy.mjs
// Actor keys are kept in ~/.config/radox-rail/mainnet-actors.json (mode 600) so a failed run can be finished.
// Against a local fork (soroban-sim serve --fork mainnet) it runs the same steps; accounts are funded
// by fork_setBalance there, since the fork does not model classic operations.
import { createHash, randomInt } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Asset, Address, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { RPC_URL, NET, addr, invokeOp, call, read, sendClassic } from "./lib/stellar.mjs";
import { wasmHash } from "./lib/contracts-lock.mjs";

const fork = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC_URL);
if (NET !== Networks.PUBLIC) throw new Error("NETWORK_PASSPHRASE must be the PUBLIC (mainnet) passphrase");
if (!fork && process.env.CONFIRM_MAINNET !== "send") throw new Error("real mainnet: set CONFIRM_MAINNET=send");
const net = await new rpc.Server(RPC_URL, { allowHttp: fork }).getNetwork();
if (net.passphrase !== Networks.PUBLIC) throw new Error(`RPC is on "${net.passphrase}", not mainnet`);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM_HASH = wasmHash("custody_registry");
const sha = (s) => createHash("sha256").update(s).digest();
const b32 = (b) => nativeToScVal(b, { type: "bytes" });
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const code = await new rpc.Server("https://soroban-testnet.stellar.org").getLedgerEntries(
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(WASM_HASH, "hex") })));
const wasm = Buffer.from(code.entries[0].val.contractCode.code);
if (sha(wasm).toString("hex") !== WASM_HASH) throw new Error("wasm from testnet does not match its hash");

// the stellar CLI asks the Ledger to sign; the signature is checked here against the admin key before sending
const ledger = (g, hd) => ({
  publicKey: () => g,
  async signTx(tx) {
    log(`approve on the Ledger: ${tx.operations.map((o) => o.type).join(", ")}`);
    const { stdout } = await promisify(execFile)("stellar", ["tx", "sign", "--sign-with-ledger", "--hd-path", String(hd),
      "--network-passphrase", NET, "--rpc-url", RPC_URL, "--quiet", tx.toXDR()], { maxBuffer: 1 << 24, timeout: 300_000 });
    const signed = TransactionBuilder.fromXDR(stdout.trim(), NET);
    const kp = Keypair.fromPublicKey(g);
    if (!signed.signatures.some((s) => kp.verify(signed.hash(), s.signature)))
      throw new Error(`the Ledger signature is not from ${g} (check ADMIN_LEDGER_HD)`);
    return signed;
  },
});
const admin = process.env.ADMIN_LEDGER ? ledger(process.env.ADMIN_LEDGER, process.env.ADMIN_LEDGER_HD ?? 0)
  : Keypair.fromSecret(process.env.MAINNET_ADMIN_SECRET);
const operator = Keypair.fromSecret(process.env.MAINNET_OPERATOR_SECRET);
// shipment actors: fresh keys, kept out of git, in the proof file only as public addresses
const actorsFile = join(homedir(), ".config/radox-rail", fork ? "mainnet-fork-actors.json" : "mainnet-actors.json");
const saved = existsSync(actorsFile) ? JSON.parse(readFileSync(actorsFile, "utf8")) : {};
const actor = (n) => saved[n] ? Keypair.fromSecret(saved[n]) : Keypair.random();
const route = Object.fromEntries(["warehouse", "trucker", "ship", "customs", "buyer"].map((n) => [n, actor(n)]));
const holder = actor("holder");
writeFileSync(actorsFile, JSON.stringify(Object.fromEntries(Object.entries({ ...route, holder }).map(([n, k]) => [n, k.secret()])), null, 2), { mode: 0o600 });
const all = { admin, operator, ...route, holder };
const keys = Object.fromEntries(Object.values(all).map((k) => [k.publicKey(), k]));
const nameOf = (g) => Object.entries(all).find(([, k]) => k.publicKey() === g)?.[0] ?? g;
const stops = Object.values(route);
const token = Asset.native().contractId(Networks.PUBLIC); // stored only, never called by the registry

const container = `RAIL${String(randomInt(0, 1e7)).padStart(7, "0")}`;
const key = sha(`${container}|BRRIO`);
const docsRoot = sha(`docs|${container}|bill-of-lading|invoice|packing-list`);
const proof = { network: fork ? "mainnet fork (local)" : "mainnet", passphrase: NET, rpc: RPC_URL, wasm_hash: WASM_HASH,
  admin: admin.publicKey(), operator: operator.publicKey(), container, key: key.toString("hex"),
  actors: Object.fromEntries(Object.entries(all).map(([n, k]) => [n, k.publicKey()])), steps: [] };
const save = () => writeFileSync(join(ROOT, "proofs", fork ? "mainnet-fork-deploy.json" : "mainnet.json"), JSON.stringify(proof, null, 2) + "\n");

async function must(label, op, signer = operator) {
  const r = await invokeOp(op, signer, keys);
  if (r.simError || r.status !== "SUCCESS") throw new Error(`${label}: ${r.simError ?? r.status} ${r.hash ?? ""}`);
  proof.steps.push({ step: label, hash: r.hash, auth: r.auth.map(nameOf) });
  save();
  log(label, r.hash, r.auth.map(nameOf).join(" + "));
  return r;
}

// accounts must exist on chain to sign their auth entries; the operator also pays its own fees
const fund = { operator: "3", ...Object.fromEntries([...Object.keys(route), "holder"].map((n) => [n, "1"])) };
if (fork) {
  const f = async (method, params) => (await (await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
  await f("fork_setBalance", { account: admin.publicKey(), xlm: 40, label: "admin" });
  for (const [n, xlm] of Object.entries(fund)) await f("fork_setBalance", { account: all[n].publicKey(), xlm: Number(xlm), label: n });
} else {
  // a rerun after a failure keeps the actors, and accounts that already exist are not created again
  for (const n of Object.keys(fund))
    if ((await fetch(`https://horizon.stellar.org/accounts/${all[n].publicKey()}`)).ok) delete fund[n];
}
if (!fork && Object.keys(fund).length) {
  const hash = await sendClassic(admin, Object.entries(fund).map(([n, xlm]) =>
    Operation.createAccount({ destination: all[n].publicKey(), startingBalance: xlm })));
  proof.steps.push({ step: "create_accounts", hash, auth: ["admin"] });
  save();
  log("create_accounts", hash);
}

// a rerun after a failed deploy does not pay for the upload twice
const onChain = (await new rpc.Server(RPC_URL, { allowHttp: fork }).getLedgerEntries(
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(WASM_HASH, "hex") })))).entries.length > 0;
if (onChain) log("upload_wasm: already on chain, skipped");
else await must("upload_wasm", () => Operation.uploadContractWasm({ wasm }), admin);
const dep = await must("deploy", (auth) => Operation.createCustomContract({ address: new Address(admin.publicKey()),
  wasmHash: Buffer.from(WASM_HASH, "hex"), constructorArgs: [addr(admin.publicKey()), addr(operator.publicKey())],
  salt: sha(`radox-rail|${container}`), auth }), admin);
const reg = dep.result;
proof.custody_registry = reg;
save();
await must("open", call(reg, "open", [b32(key), addr(token), nativeToScVal(stops.map((k) => new Address(k.publicKey()))), b32(docsRoot)]));
for (let i = 0; i < 4; i++)
  await must(`handover_${i + 1}`, call(reg, "handover",
    [b32(key), addr(stops[i].publicKey()), addr(stops[i + 1].publicKey()), b32(sha(`handover-${i + 1}|${container}`)), u32(3)]));
await must("deliver", call(reg, "deliver", [b32(key), addr(stops[4].publicKey()), addr(holder.publicKey())]));

const s = await read(reg, "get", [b32(key)], operator);
proof.final_status = [].concat(s.status)[0];
proof.final_seq = s.seq;
proof.final_head = Buffer.from(await read(reg, "head", [b32(key)], operator)).toString("hex");
save();
if (proof.final_status !== "Delivered") throw new Error(`final status ${proof.final_status}`);
log(`done: registry ${reg}, ${proof.steps.length} transactions, status ${proof.final_status}, seq ${proof.final_seq}`);
