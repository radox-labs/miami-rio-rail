// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Read-only view of the two testnet shipments. State: contract get(key) through simulateTransaction
// (no account, no signature). History: Horizon transaction parameters in ledger order, not getEvents
// (the RPC keeps events about 7 days). "Verify head" recomputes the head chain exactly as
// scripts/verify-head.mjs. If RPC or Horizon cannot be reached, snapshot.json (from proofs/,
// scripts/page-snapshot.mjs) is shown, labelled as a snapshot.
const S = window.StellarSdk;
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const EXPERT = "https://stellar.expert/explorer/testnet";

const $ = (id) => document.getElementById(id);
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
const sha = async (...parts) => new Uint8Array(await crypto.subtle.digest("SHA-256", cat(...parts)));
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const addrBytes = (g) => Uint8Array.from(S.nativeToScVal(g, { type: "address" }).toXDR());
const bytes = (v) => Uint8Array.from(v);

// the head layout, byte for byte as in the contract and scripts/verify-head.mjs
const headOpen = (key, docsRoot) => sha(Uint8Array.of(1), key, docsRoot);
const headHandover = (head, from, to, evidence, seq, assurance) =>
  sha(Uint8Array.of(2), head, addrBytes(from), addrBytes(to), evidence, be32(seq), be32(assurance));
const headAttest = (head, source, kind, eventHash, seq) =>
  sha(Uint8Array.of(3), head, addrBytes(source), be32(kind), eventHash, be32(seq));

let proof, snapshot, names;
let run = 0; // bumped on every load; a load that is no longer current stops writing to the page

// one line per shipment, in the README's words
const ABOUT = [
  "All keys in this shipment are our test keys, held by one harness.",
  "Two teammates, Leo (GDWN…TPPW) and Vhendala (GAUK…CEFR), authorised their handovers on their own computers with their own testnet keys, by their account. Our operator machine submitted the transactions; the other keys are our test keys on one machine.",
];

const short = (s) => `${s.slice(0, 6)}…${s.slice(-6)}`;
const key4 = (g) => `${g.slice(0, 4)}…${g.slice(-4)}`;
const who = (g) => names[g] ?? short(g);
const link = (path, text, label) => {
  const a = document.createElement("a");
  a.href = `${EXPERT}/${path}`;
  a.textContent = text;
  if (label) a.setAttribute("aria-label", label);
  return a;
};
const row = (parent, k, v) => {
  const d = document.createElement("div");
  d.className = "row";
  const a = document.createElement("span");
  a.textContent = k;
  const b = typeof v === "string" ? Object.assign(document.createElement("span"), { textContent: v }) : v;
  d.append(a, b);
  parent.append(d);
};

async function txRecord(hash, ctx) {
  if (ctx.live) {
    try {
      // 16 reads go out at once; one retry on 429 so a burst limit does not drop the page to the snapshot
      const get = async (u) => { const r = await fetch(u); return r.status === 429 ? (await new Promise((ok) => setTimeout(ok, 800)), fetch(u)) : r; };
      const t = await get(`${HORIZON}/transactions/${hash}`);
      const o = await get(`${HORIZON}/transactions/${hash}/operations`);
      if (t.ok && o.ok) return { transaction: await t.json(), operations: await o.json() };
    } catch { /* fall through to the snapshot */ }
    ctx.live = false;
  }
  const r = snapshot.tx[hash];
  if (!r) throw new Error(`no saved copy of ${short(hash)}`);
  return r;
}

// Reads the shipment record directly from `custody_registry.get(key)` on Soroban testnet RPC.
// Note on the external Radox API shown in the demo (`GET /api/custody/shipments/:key`):
// that HTTP endpoint lives in Radox's closed backend and is not
// public because it is part of the startup's prior platform implementation built before the
// event. Internally, that endpoint executes this exact read-only `simulateTransaction` call
// on `custody_registry.get(key)` and returns:
//   `{ success: true, data: { key, contract, status, currentCustodian, route, seq, head, holder } }`
// (or `400 E_CUSTODY_KEY` / `404 E_CUSTODY_NOT_FOUND`).
async function onchainShipment(key) {
  const server = new S.rpc.Server(RPC);
  const src = new S.Account(S.Keypair.random().publicKey(), "0");
  const tx = new S.TransactionBuilder(src, { fee: "100", networkPassphrase: S.Networks.TESTNET })
    .addOperation(S.Operation.invokeContractFunction({ contract: proof.custody_registry, function: "get",
      args: [S.nativeToScVal(key, { type: "bytes" })] }))
    .setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) {
    const unknown = /Error\(Contract, #\d+\)/.test(sim.error);
    throw Object.assign(new Error(sim.error.split("\n")[0]), { unknown });
  }
  return S.scValToNative(sim.result.retval);
}

// successful registry calls for this key, in ledger order
async function txHistory(keyHex, ctx) {
  const hashes = [...proof.lifecycle.map((x) => x.hash), ...(proof.attest ?? []).map((x) => x.hash)];
  const recs = [];
  for (const [h, r] of await Promise.all(hashes.map(async (h) => [h, await txRecord(h, ctx)]))) {
    if (!r.transaction.successful) continue;
    for (const op of r.operations._embedded.records) {
      if (op.type !== "invoke_host_function" || !op.parameters) continue;
      const decode = (p) => S.xdr.ScVal.fromXDR(p.value, "base64");
      if (S.scValToNative(decode(op.parameters[0])) !== proof.custody_registry) continue;
      const args = op.parameters.slice(2).map((p) => S.scValToNative(decode(p)));
      if (hex(bytes(args[0])) !== keyHex) continue;
      recs.push({ ledger: r.transaction.ledger, order: r.transaction.application_order ?? 0,
        paging: BigInt(op.paging_token), fn: S.scValToNative(decode(op.parameters[1])), args, hash: h,
        time: r.transaction.created_at });
    }
  }
  return recs.sort((a, b) => a.ledger - b.ledger || a.order - b.order || (a.paging < b.paging ? -1 : 1));
}

async function recompute(recs) {
  let head = null, seq = 0;
  for (const r of recs) {
    const a = r.args;
    if (r.fn === "open") { head = await headOpen(bytes(a[0]), bytes(a[3])); seq = 0; }
    else if (r.fn === "handover") { seq += 1; head = await headHandover(head, a[1], a[2], bytes(a[3]), seq, a[4]); }
    else if (r.fn === "attest") head = await headAttest(head, a[1], a[2], bytes(a[3]), seq);
    else continue; // deliver, freeze, unfreeze do not change head
    r.head = hex(head);
  }
  return head && hex(head);
}

function showHistory(recs) {
  const list = $("history");
  list.replaceChildren();
  for (const r of recs) {
    const li = document.createElement("li");
    const what = r.fn === "open" ? `Shipment registered. Planned route: ${r.args[2].length} companies`
      : r.fn === "handover" ? `${who(r.args[1])} → ${who(r.args[2])}, both signed`
      : r.fn === "attest" ? `Status update recorded by ${who(r.args[1])}`
      : r.fn === "deliver" ? `Delivered by ${who(r.args[1])} to ${who(r.args[2])}, both signed` : r.fn;
    const t = document.createElement("span");
    t.textContent = what;
    const meta = document.createElement("span");
    meta.className = "meta";
    if (r.fn === "handover" || r.fn === "deliver") {
      // the contract requires both from and to to authorise these calls
      const ks = document.createElement("span");
      ks.textContent = `Signed by ${who(r.args[1])} and ${who(r.args[2])} · `;
      ks.title = `keys ${r.args[1]}\n${r.args[2]}${r.fn === "handover" ? `\nassurance ${r.args[4]} (1 to 3, declared by the caller; the contract checks only the range)` : ""}`;
      meta.append(ks);
    }
    meta.title = `ledger ${r.ledger}`;
    meta.append("transaction ", link(`tx/${r.hash}`, short(r.hash), `Transaction ${r.hash}`));
    li.append(t, meta);
    list.append(li);
  }
  const redeem = proof.lifecycle.find((x) => x.step === "redeem");
  if (redeem) {
    const li = document.createElement("li");
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.append(link(`tx/${redeem.hash}`, short(redeem.hash), `Transaction ${redeem.hash}`));
    li.append(Object.assign(document.createElement("span"), { textContent: "Ownership token cancelled: the goods were claimed" }), meta);
    list.append(li);
  }
}

let recsCache, onchainHead, headFrom;

async function load(i) {
  const my = ++run;
  snapshot ??= await (await fetch("snapshot.json")).json();
  if (my !== run) return;
  proof = snapshot.shipments[i];
  const ctx = { live: true }; // per load, so a stale load cannot flip this one to the snapshot
  names = Object.fromEntries(Object.entries(proof.actors).map(([n, g]) => [g, n[0].toUpperCase() + n.slice(1)]));
  for (const b of document.querySelectorAll("#switch button")) b.setAttribute("aria-pressed", String(b.dataset.s === String(i)));
  $("about").textContent = ABOUT[i];
  $("verify").disabled = true;
  $("verify").textContent = "Loading record…";
  $("result").replaceChildren();
  $("result").className = "result";
  $("result").title = "";
  $("status").textContent = "";
  $("source").textContent = "Loading from Stellar testnet…";
  $("source").className = "source";
  $("history").replaceChildren(Object.assign(document.createElement("li"), { textContent: "Loading…" }));
  const keyHex = proof.shipment.key;
  const state = $("state");
  state.replaceChildren();
  row(state, "Container", `${proof.shipment.container} · from ${proof.shipment.origin}`);

  let ship = null, unknown = false;
  try { ship = await onchainShipment(unhex(keyHex)); }
  catch (e) {
    if (my !== run) return;
    unknown = e.unknown;
    if (unknown) { $("status").textContent = "This shipment key is not in the contract. Testnet may have been reset."; }
    ctx.live = false;
  }
  if (my !== run) return;
  const recs = await txHistory(keyHex, ctx);
  if (my !== run) return;
  recsCache = recs;

  if (ship) {
    const status = Array.isArray(ship.status) ? ship.status[0] : ship.status;
    row(state, "Status", status);
    row(state, "Holder now", who(ship.current_custodian));
    row(state, "Handovers", `${ship.seq} of ${ship.route.length - 1}`);
    if (ship.holder) row(state, "Owner of the goods", who(ship.holder));
    onchainHead = hex(bytes(ship.head));
    headFrom = "on-chain";
  } else {
    const redeemed = proof.lifecycle.some((x) => x.step === "redeem");
    row(state, "Status", redeemed ? "Delivered, then redeemed (from the saved proof)" : "Delivered (from the saved proof)");
    onchainHead = proof.shipment.final_head;
    headFrom = "saved";
  }
  const h = document.createElement("code");
  h.textContent = short(onchainHead);
  h.title = onchainHead;
  row(state, ship ? "Tamper-proof fingerprint" : "Fingerprint (saved copy)", h);
  row(state, "Contract", link(`contract/${proof.custody_registry}`, short(proof.custody_registry), `Contract ${proof.custody_registry}`));

  showHistory(recsCache);
  const allLive = ctx.live && ship;
  $("source").textContent = allLive ? "Live from Stellar testnet"
    : unknown ? "Snapshot, not live: key not found on testnet" : "Snapshot, not live: testnet could not be reached";
  $("source").className = allLive ? "source" : "source warn";
  $("verify").disabled = false;
  $("verify").textContent = "Check the fingerprint";
  if (!allLive) $("fp-note").textContent = "Testnet could not be reached. This compares against the saved copy, not Stellar.";
}

$("verify").addEventListener("click", async () => {
  const out = $("result");
  const my = run;
  out.textContent = "Recomputing…";
  let got;
  try { got = await recompute(recsCache); }
  catch (e) { if (my === run) { out.className = "result bad"; out.textContent = `Could not recompute: ${e.message}`; } return; }
  if (my !== run) return;
  showHistory(recsCache);
  const ok = got === onchainHead;
  out.className = ok ? "result ok" : "result bad";
  out.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = ok ? "MATCH" : "MISMATCH";
  const detail = document.createElement("span");
  detail.textContent = !ok ? " The rebuilt fingerprint does not match." : headFrom === "saved" ? " Matches the saved copy only. Stellar could not be reached, so this is not a live check." : ` The history matches the fingerprint on Stellar: no step was changed, added or removed. Rebuilt from ${recsCache.length} recorded steps.`;
  out.append(strong, detail);
  out.title = `recomputed ${got}\n${headFrom} head ${onchainHead}`;
});

const start = (i) => { const my = run + 1; load(i).catch((e) => {
  if (my !== run) return;
  $("status").textContent = "Could not load the record. Reload to try again."; $("verify").textContent = "Record not loaded";
}); };
for (const b of document.querySelectorAll("#switch button")) {
  b.addEventListener("click", () => {
    const i = Number(b.dataset.s);
    history.replaceState(null, "", i ? "#shipment-2" : location.pathname);
    start(i);
  });
}
const fromHash = () => (location.hash === "#shipment-2" ? 1 : 0);
addEventListener("hashchange", () => start(fromHash()));
start(fromHash());
