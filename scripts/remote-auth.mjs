// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// One shipment whose custodians authorise their own handovers from their own computers.
// Only public keys and authorization entries cross between machines; no secret ever does.
//
//   prepare  (operator machine)  deploy a registry, open a shipment on the route
//            warehouse -> LEO -> VHENDALA -> recipient, write one request file per custodian
//   sign     (custodian machine) show in plain words what the request authorises; with --yes sign
//            it with that machine's own key and write a response file
//   submit   (operator machine)  check the responses, send 3 handovers and the delivery,
//            write the proof file
//
//   node scripts/remote-auth.mjs prepare --leo G... --vhendala G... [--dir work/3m] [--hours 36]
//   node scripts/remote-auth.mjs sign --request request-leo.json --registry C... --key NAME
//        --known Name=G... [--known ...] [--out response-leo.json] [--yes]
//   node scripts/remote-auth.mjs submit --dir work/3m --leo response-leo.json
//        --vhendala response-vhendala.json [--proof proofs/three-machine.json] [--rehearsal]
// A key is a `stellar keys` name (never a file); on a custodian machine SIGNER_SECRET also works.
// Operator keys rmr3-operator, rmr3-warehouse, rmr3-recipient, rmr3-holder are created on first use.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  Keypair, Operation, Address, TransactionBuilder, rpc, xdr, nativeToScVal, scValToNative, authorizeEntry,
} from "@stellar/stellar-sdk";
import { NET, HORIZON, server, addr, sleep, call, read, invokeOp, waitFor } from "./lib/stellar.mjs";

const REGISTRY_WASM = process.env.REGISTRY_WASM_HASH ?? "8230ed937f443e40054d0806c9cdd044ef341db19f0c1b3123c573adb7a41342";
const TOKEN = "CBCWTIT5YNPNSA4ZSJJXUFZKGQROZPWNWYNZ4CSO7HLWJXU7Z6N5Q22Z"; // the asset contract of proofs/lifecycle.json
const MAX_DAYS = 7;          // sign refuses a request valid for longer
const LEDGER_S = 5;          // testnet closes a ledger about every 5 s
const sha = (s) => createHash("sha256").update(s).digest();
const b32 = (buf) => nativeToScVal(buf, { type: "bytes" });
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (m) => { console.error(m); process.exit(1); };
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)));

function flags(argv) {
  const o = { known: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) die(`unexpected argument ${argv[i]}`);
    const k = argv[i].slice(2);
    const v = ["yes", "rehearsal", "allow-unknown"].includes(k) ? true : argv[++i];
    if (v === undefined) die(`--${k} needs a value`);
    if (k === "known") o.known.push(v); else o[k] = v;
  }
  return o;
}

// --- keys: always a `stellar keys` name or an env var, never a file we write ---------------------
const cli = (...a) => execFileSync("stellar", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function loadKey(name) {
  try { return Keypair.fromSecret(cli("keys", "secret", name)); }
  catch { die(`No key named "${name}" on this machine. Create it: stellar keys generate ${name} --network testnet --fund`); }
}
function operatorKey(name) {
  try { cli("keys", "address", name); } catch { cli("keys", "generate", name, "--network", "testnet", "--fund"); log("created key", name); }
  return loadKey(name);
}

// --- authorization entries ------------------------------------------------------------------
const nonce = () => BigInt.asIntN(64, BigInt("0x" + randomBytes(8).toString("hex")));
function unsignedEntry(registry, fn, args, signerG) {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
      contractAddress: new Address(registry).toScAddress(), functionName: fn, args })),
    subInvocations: [] });
  return new xdr.SorobanAuthorizationEntry({
    rootInvocation: invocation,
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(new xdr.SorobanAddressCredentials({
      address: new Address(signerG).toScAddress(), nonce: nonce(), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVec([]) })),
  });
}
const credOf = (e) => e.credentials.addressV2 ?? e.credentials.address;
const entryAddress = (e) => Address.fromScAddress(credOf(e).address).toString();
const rootFn = (e) => e.rootInvocation.function.contractFn ?? e.rootInvocation.function.value;
const unxdr = (b64) => xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64");
const toXdr = (e) => e.toXDR("base64");
const hex = (b) => Buffer.from(b).toString("hex");

// --- prepare --------------------------------------------------------------------------------
async function prepare(f) {
  const [leo, vhendala] = [f.leo, f.vhendala];
  for (const g of [leo, vhendala]) if (!/^G[A-Z2-7]{55}$/.test(g ?? "")) die("need --leo G... and --vhendala G... (public keys)");
  const dir = resolve(f.dir ?? "work/three-machine");
  mkdirSync(dir, { recursive: true });
  const k = { operator: operatorKey("rmr3-operator"), warehouse: operatorKey("rmr3-warehouse"),
    recipient: operatorKey("rmr3-recipient"), holder: operatorKey("rmr3-holder") };
  const pub = (n) => k[n].publicKey();

  // a fresh registry whose admin and operator are the operator machine's own key
  const salt = randomBytes(32); // fixed before the calls: simulation and send must see the same deployment
  const dep = await invokeOp((auth) => Operation.createCustomContract({
    address: new Address(pub("operator")), wasmHash: Buffer.from(REGISTRY_WASM, "hex"),
    constructorArgs: [addr(pub("operator")), addr(pub("operator"))], salt, auth }),
    k.operator, { [pub("operator")]: k.operator });
  if (dep.status !== "SUCCESS") die(`registry deploy: ${dep.simError ?? dep.status}`);
  const registry = dep.result;
  log("registry", registry, dep.hash);

  const container = `TEST${String(randomInt(0, 1e7)).padStart(7, "0")}`;
  const origin = "BRRIO";
  const key = sha(`${container}|${origin}`);
  const docsRoot = sha(`docs|${container}|bill-of-lading-TEST|invoice-TEST|packing-list-TEST`);
  const stops = [pub("warehouse"), leo, vhendala, pub("recipient")];
  const opn = await invokeOp(call(registry, "open",
    [b32(key), addr(TOKEN), nativeToScVal(stops.map((g) => new Address(g))), b32(docsRoot)]), k.operator, { [pub("operator")]: k.operator });
  if (opn.status !== "SUCCESS") die(`open: ${opn.simError ?? opn.status}`);
  log("open", opn.hash);

  const until = (await server.getLatestLedger()).sequence + Math.round(Number(f.hours ?? 36) * 3600 / LEDGER_S);
  const ev = (i) => sha(`handover-${i}|${container}`);
  const handoverArgs = (i) => [b32(key), addr(stops[i]), addr(stops[i + 1]), b32(ev(i + 1)), u32(3)];
  const entries = []; // { id, address, xdr }
  for (let i = 0; i < 3; i++) for (const [role, g] of [["from", stops[i]], ["to", stops[i + 1]]])
    entries.push({ id: `h${i + 1}-${role}`, address: g, xdr: toXdr(unsignedEntry(registry, "handover", handoverArgs(i), g)) });
  const state = { registry, token: TOKEN, container, origin, key: key.toString("hex"), docs_root: docsRoot.toString("hex"),
    stops, until_ledger: until, entries, setup: [{ step: "custody_registry_deploy", hash: dep.hash }],
    lifecycle: [{ step: "open", hash: opn.hash }], actors: { operator: pub("operator"), warehouse: pub("warehouse"),
      leo, vhendala, recipient: pub("recipient"), holder: pub("holder") } };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");

  const id = randomBytes(6).toString("hex");
  for (const [who, g] of [["leo", leo], ["vhendala", vhendala]]) {
    const req = { format: "rmr-auth-request/1", request_id: `${id}-${who}`, network: "testnet", registry, until_ledger: until,
      signer: g, entries: entries.filter((e) => e.address === g).map(({ id: i, xdr: x }) => ({ id: i, xdr: x })) };
    writeFileSync(join(dir, `request-${who}.json`), JSON.stringify(req, null, 2) + "\n");
  }
  log(`wrote ${dir}/request-leo.json and request-vhendala.json; signatures valid until ledger ${until}`);
  // for the custodians, over a channel other than the request files (the board)
  console.log(`\nPost on both cards:\n  --registry ${registry} --known Warehouse=${pub("warehouse")} --known Leo=${leo} --known Vhendala=${vhendala} --known Recipient=${pub("recipient")}`);
}

// --- sign (custodian machine) -------------------------------------------------------------
// Everything shown comes from decoding the XDR itself, never from a text field of the file.
async function sign(f) {
  if (!f.request || !f.registry || !f.key && !process.env.SIGNER_SECRET) die("need --request FILE --registry C... --key NAME");
  const kp = process.env.SIGNER_SECRET ? Keypair.fromSecret(process.env.SIGNER_SECRET) : loadKey(f.key);
  const me = kp.publicKey();
  const names = new Map(f.known.map((s) => { const [n, g] = s.split("="); return [g, n]; }));
  const req = JSON.parse(readFileSync(f.request, "utf8"));
  const stop = (m) => die(`REFUSED, nothing signed: ${m}`);

  if (req.format !== "rmr-auth-request/1") stop("not a request file of this tool");
  if (req.registry !== f.registry) stop(`the request names registry ${req.registry}, you gave ${f.registry}`);
  const latest = (await server.getLatestLedger()).sequence;
  const until = req.until_ledger;
  if (!Number.isInteger(until) || until <= latest) stop("the request has expired; ask for a new one");
  if (until - latest > MAX_DAYS * 86400 / LEDGER_S) stop(`valid for more than ${MAX_DAYS} days`);
  if (!req.entries?.length) stop("no entries");

  const label = (g) => g === me ? "YOU" : names.get(g) ?? (f["allow-unknown"] ? `UNKNOWN ${g}` : stop(`address ${g} is not in your --known list`));
  const lines = [];
  const signed = [];
  for (const item of req.entries) {
    let e;
    try { e = unxdr(item.xdr); } catch { stop(`entry ${item.id} is not valid XDR`); }
    if (e.credentials.type === "sorobanCredentialsSourceAccount") stop(`entry ${item.id} would authorise as the transaction source`);
    if (entryAddress(e) !== me) stop(`entry ${item.id} is for ${entryAddress(e)}, not for your key ${me}`);
    if (e.rootInvocation.subInvocations.length) stop(`entry ${item.id} also authorises sub-calls`);
    const fn = e.rootInvocation.function;
    if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") stop(`entry ${item.id} is not a plain contract call`);
    const c = rootFn(e);
    const contract = Address.fromScAddress(c.contractAddress).toString();
    if (contract !== f.registry) stop(`entry ${item.id} calls contract ${contract}, not the registry ${f.registry}`);
    const name = c.functionName.toString();
    const a = c.args.map((v) => scValToNative(v));
    if (name === "handover" && a.length === 5) {
      const [shipment, from, to, evidence, assurance] = a;
      if (me !== from && me !== to) stop(`entry ${item.id}: you are neither the outgoing nor the incoming custodian`);
      lines.push(`  ${item.id}: HANDOVER of shipment ${hex(shipment)}\n      from ${label(from)} (${from})\n      to   ${label(to)} (${to})\n      evidence hash ${hex(evidence)}, assurance level ${assurance}\n      You sign as the ${me === from ? "OUTGOING" : "INCOMING"} custodian.`);
    } else if (name === "deliver" && a.length === 3) {
      const [shipment, last, holder] = a;
      if (me !== last && me !== holder) stop(`entry ${item.id}: you are neither the final custodian nor the holder`);
      lines.push(`  ${item.id}: DELIVERY of shipment ${hex(shipment)}\n      final custodian ${label(last)}, holder ${label(holder)}\n      You sign as the ${me === last ? "FINAL CUSTODIAN" : "HOLDER"}.`);
    } else stop(`entry ${item.id} calls "${name}" with ${a.length} arguments; this tool signs only handover and deliver`);
    signed.push({ id: item.id, e });
  }
  console.log(`You are ${me} (${f.key ?? "SIGNER_SECRET"}). Network: testnet. Registry: ${f.registry}.`);
  console.log(`Each authorisation below works once, for exactly that call, until ledger ${until} (about ${((until - latest) * LEDGER_S / 3600).toFixed(1)} h from now).`);
  console.log("It moves no funds. Check the addresses against the list you were given, then continue.\n" + lines.join("\n"));
  if (!f.yes) { console.log("\nNothing signed yet. If every line is right, run the same command again with --yes."); return; }

  const out = f.out ?? f.request.replace(/request/, "response");
  const resp = { format: "rmr-auth-response/1", request_id: req.request_id, signer: me, until_ledger: until,
    entries: await Promise.all(signed.map(async ({ id, e }) => ({ id, xdr: toXdr(await authorizeEntry(e, kp, until, NET)) }))) };
  writeFileSync(out, JSON.stringify(resp, null, 2) + "\n");
  console.log(`\nSigned ${resp.entries.length} authorisation(s) -> ${out}. It holds only signatures, no secret; send it back.`);
}

// --- submit ---------------------------------------------------------------------------------
async function sendHandover(registry, op, source) {
  let tx = new TransactionBuilder(await server.getAccount(source.publicKey()), { fee: "5000000", networkPassphrase: NET })
    .addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error.split("\n")[0]);
  tx = rpc.assembleTransaction(tx, sim).build();
  tx.sign(source);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
  const r = await waitFor(sent.hash);
  if (r.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${r.status}`);
  return sent.hash;
}

async function horizonSave(hash, dir) {
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

async function submit(f) {
  const dir = resolve(f.dir ?? "work/three-machine");
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const k = { operator: loadKey("rmr3-operator"), warehouse: loadKey("rmr3-warehouse"),
    recipient: loadKey("rmr3-recipient"), holder: loadKey("rmr3-holder") };
  const latest = (await server.getLatestLedger()).sequence;
  if (st.until_ledger <= latest) die("the signatures have expired; run prepare again");

  // the operator's own entries are signed here; the custodians' come from their response files
  const remote = new Map();
  for (const [who, file] of [["leo", f.leo], ["vhendala", f.vhendala]]) {
    const resp = JSON.parse(readFileSync(file, "utf8"));
    if (resp.signer !== st.actors[who]) die(`${file} was signed by ${resp.signer}, expected ${who} ${st.actors[who]}`);
    for (const r of resp.entries) remote.set(r.id, r.xdr);
  }
  const own = Object.fromEntries(Object.entries(k).map(([n, kp]) => [kp.publicKey(), kp]));
  const entryFor = async (item) => {
    const base = unxdr(item.xdr);
    if (own[item.address]) return authorizeEntry(base, own[item.address], st.until_ledger, NET);
    const got = remote.get(item.id);
    if (!got) die(`no signed entry for ${item.id} (${item.address}) in the response files`);
    const e = unxdr(got);
    if (hex(e.rootInvocation.toXDR()) !== hex(base.rootInvocation.toXDR()) || entryAddress(e) !== item.address)
      die(`${item.id}: the signed entry is not for the call that was requested`);
    if (!plain(credOf(e).signature).vec?.length) die(`${item.id}: not signed`);
    return e;
  };

  const lifecycle = [...st.lifecycle];
  const key = Buffer.from(st.key, "hex");
  for (let i = 1; i <= 3; i++) {
    const items = st.entries.filter((e) => e.id.startsWith(`h${i}-`));
    const auth = await Promise.all(items.map(entryFor));
    const e0 = rootFn(auth[0]);
    const op = Operation.invokeContractFunction({ contract: st.registry, function: "handover", args: e0.args, auth });
    const hash = await sendHandover(st.registry, op, k.operator);
    lifecycle.push({ step: "handover", hash });
    log(`handover ${i}`, hash);
  }
  const rc = st.actors.recipient;
  const del = await invokeOp(call(st.registry, "deliver", [b32(key), addr(rc), addr(st.actors.holder)]), k.operator,
    { [rc]: k.recipient, [st.actors.holder]: k.holder });
  if (del.status !== "SUCCESS") die(`deliver: ${del.simError ?? del.status}`);
  lifecycle.push({ step: "deliver", hash: del.hash });
  log("deliver", del.hash);

  const finalHead = hex(await read(st.registry, "head", [b32(key)], k.operator));
  const proofPath = resolve(f.proof ?? "proofs/three-machine.json");
  const proof = { network: "testnet", ...(f.rehearsal ? { rehearsal: true } : {}), custody_registry: st.registry, token: st.token,
    shipment: { container: st.container, origin: st.origin, key: st.key, docs_root: st.docs_root, route: st.stops, final_head: finalHead },
    actors: st.actors, setup: st.setup, lifecycle, attest: [],
    authorisation: "handover 1: warehouse + leo; handover 2: leo + vhendala; handover 3: vhendala + recipient; deliver: recipient + holder. leo and vhendala signed their entries on their own computers." };
  for (const x of lifecycle) await horizonSave(x.hash, join(dirname(proofPath), "tx"));
  writeFileSync(proofPath, JSON.stringify(proof, null, 2) + "\n");
  log(`done -> ${proofPath}; verify with: PROOF_FILE=${proofPath} node scripts/verify-head.mjs ${st.key}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds = { prepare, sign, submit };
if (!cmds[cmd]) die("usage: remote-auth.mjs prepare | sign | submit (see the header of this file)");
cmds[cmd](flags(rest)).catch((e) => die(e.message));
