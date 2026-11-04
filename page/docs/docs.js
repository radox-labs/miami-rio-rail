// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// "Try the API": runs the sandbox calls live against this site's /api and shows the request,
// the response and the explorer link. Everything from the API is written with textContent.
const $ = (id) => document.getElementById(id);
const ROLES = ["warehouse", "trucker", "ship", "customs", "buyer"];
const ERRORS = [
  ["E_WRONG_CUSTODIAN", 409, "The company handing over is not the one holding the shipment (registry error 1)."],
  ["E_OUT_OF_ROUTE", 409, "The receiving company is not the next stop on the route (registry error 2)."],
  ["E_NOT_OPEN", 409, "The shipment is already delivered (registry error 3)."],
  ["E_PAUSED", 409, "The registry is paused by its admin (registry error 6)."],
  ["E_FROZEN", 409, "The shipment is frozen by the admin (registry error 7)."],
  ["E_NOT_FINAL", 409, "Delivery before every handover is done (registry error 10)."],
  ["E_BAD_ASSURANCE", 409, "Assurance outside 1 to 3 (registry error 13)."],
  ["E_ROUTE_COMPLETE", 409, "Every handover is done: deliver it next."],
  ["E_KEY", 400, "The key is not 64 lowercase hex characters."],
  ["E_ASSURANCE", 400, "\"assurance\" is not a whole number from 0 to 1000; the registry accepts 1 to 3."],
  ["E_METHOD", 405, "Wrong HTTP method for this path."],
  ["E_ROLE", 400, "\"from\" is not one of the five companies, or is the receiving one."],
  ["E_NOT_FOUND", 404, "No shipment with this key on the rail's testnet registries."],
  ["E_NOT_SANDBOX", 404, "The shipment was not opened by the sandbox, so the sandbox holds none of its keys."],
  ["E_AUTH", 403, "A required signature is missing or invalid."],
  ["E_RATE_LIMIT", 429, "Too many calls from your address; wait 10 minutes and try again."],
  ["E_SANDBOX_CAP", 429, "The sandbox reached its hourly cap for everyone; read a shipment instead."],
  ["E_NETWORK", 502, "Stellar testnet could not be reached or did not accept the call; try again."],
  ["E_TX_FAILED", 502, "The transaction was sent but failed on testnet; the answer links it."],
  ["E_TIMEOUT", 504, "The transaction was sent but not seen within 40 seconds; the answer links it."],
  ["E_MAINNET_NOT_DEPLOYED", 503, "network=mainnet: no mainnet registry is configured. Nothing is sent to mainnet."],
  ["E_NETWORK_PARAM", 400, "\"network\" is not testnet or mainnet."],
  ["E_SANDBOX_OFF", 503, "The sandbox is not configured on this deployment."],
  ["E_SANDBOX_EMPTY", 503, "The sandbox account is low on testnet XLM."],
];

for (const [code, http, text] of ERRORS) {
  const tr = document.createElement("tr");
  for (const [v, isCode] of [[code, true], [String(http), false], [text, false]]) {
    const td = document.createElement("td");
    if (isCode) td.append(Object.assign(document.createElement("code"), { textContent: v })); else td.textContent = v;
    tr.append(td);
  }
  $("errtable").append(tr);
}

document.querySelectorAll(".copy").forEach((b) => b.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(b.previousElementSibling.textContent); b.textContent = "Copied"; } catch { b.textContent = "Select it"; }
  setTimeout(() => { b.textContent = "Copy"; }, 1500);
}));

// --- verify in the browser, trusting no server: Horizon for the arguments, RPC for the head ------
// The same bytes as the contract and app.js (contracts/custody_registry/src/lib.rs).
const SDK = () => window.StellarSdk;
const hexb = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const sha = async (...p) => new Uint8Array(await crypto.subtle.digest("SHA-256", cat(...p)));
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const addrBytes = (g) => Uint8Array.from(SDK().nativeToScVal(g, { type: "address" }).toXDR());

async function verifyInBrowser(registry, keyHex, hashes) {
  const S = SDK();
  const recs = [];
  for (const h of hashes) {
    const t = await (await fetch(`https://horizon-testnet.stellar.org/transactions/${h}`)).json();
    const ops = await (await fetch(`https://horizon-testnet.stellar.org/transactions/${h}/operations`)).json();
    for (const op of ops._embedded.records) {
      if (op.type !== "invoke_host_function" || !op.parameters) continue;
      const v = op.parameters.map((p) => S.scValToNative(S.xdr.ScVal.fromXDR(p.value, "base64")));
      if (v[0] !== registry || hexb(v[2]) !== keyHex) continue;
      recs.push({ ledger: t.ledger, paging: BigInt(op.paging_token), fn: v[1], a: v.slice(2) });
    }
  }
  recs.sort((x, y) => x.ledger - y.ledger || (x.paging < y.paging ? -1 : 1));
  let head = null, seq = 0;
  for (const { fn, a } of recs) {
    if (fn === "open") { head = await sha(Uint8Array.of(1), a[0], a[3]); seq = 0; }
    else if (fn === "handover") { seq += 1; head = await sha(Uint8Array.of(2), head, addrBytes(a[1]), addrBytes(a[2]), a[3], be32(seq), be32(a[4])); }
    else if (fn === "attest") head = await sha(Uint8Array.of(3), head, addrBytes(a[1]), be32(a[2]), a[3], be32(seq));
  }
  // the head stored in the contract, read straight from the public RPC
  const src = new S.Account(S.Keypair.random().publicKey(), "0");
  const tx = new S.TransactionBuilder(src, { fee: "100", networkPassphrase: S.Networks.TESTNET })
    .addOperation(S.Operation.invokeContractFunction({ contract: registry, function: "head", args: [S.nativeToScVal(Uint8Array.from(keyHex.match(/../g), (x) => parseInt(x, 16)), { type: "bytes" })] }))
    .setTimeout(60).build();
  const sim = await new S.rpc.Server("https://soroban-testnet.stellar.org").simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error("head read failed");
  return { recomputed: head && hexb(head), onchain: hexb(S.scValToNative(sim.result.retval)), steps: recs.length };
}

// --- the panel -----------------------------------------------------------------------------
let key = null, ship = null, busy = false;
const buttons = ["b-open", "b-hand", "b-wrong", "b-deliver", "b-verify"].map($);

function drawRoute() {
  const r = $("t-route");
  r.replaceChildren();
  ROLES.forEach((name, i) => {
    const d = document.createElement("div");
    const here = ship && ship.status !== "Delivered" && ship.seq === i;
    d.className = `stop${here ? " here" : ""}${ship && (i < ship.seq || ship.status === "Delivered") ? " done" : ""}`;
    const disc = Object.assign(document.createElement("span"), { className: "disc", textContent: ship?.status === "Delivered" && i === 4 ? "✓" : String(i + 1) });
    d.append(disc, Object.assign(document.createElement("span"), { textContent: name }));
    if (here) d.setAttribute("aria-current", "step");
    r.append(d);
  });
}

function refreshButtons() {
  const open = ship?.status === "Open";
  $("b-open").disabled = busy;
  $("b-hand").disabled = busy || !open || ship.seq >= 4;
  $("b-wrong").disabled = busy || !open || ship.seq >= 3;
  $("b-deliver").disabled = busy || !open;
  $("b-verify").disabled = busy || !key;
  $("b-open").className = !ship || ship.status === "Delivered" ? "" : "ghost";
  $("b-hand").className = open && ship.seq < 4 ? "" : "ghost";
  $("b-deliver").className = open && ship.seq === 4 ? "" : "ghost";
}

const short = (s) => (typeof s === "string" && s.length > 20 ? `${s.slice(0, 8)}…${s.slice(-8)}` : s);

// trimmed view of the JSON: addresses, hashes and links shortened so the screen reads at a glance
// (the explorer link under the panes carries the full hash)
function view(body) {
  return JSON.stringify(body, (k, v) => (typeof v === "string" && (/^[GC][A-Z2-7]{55}$/.test(v) || /^[0-9a-f]{64}$/.test(v)) ? short(v)
    : typeof v === "string" && v.startsWith("https://stellar.expert/") ? `stellar.expert/…/${short(v.split("/").pop())}` : v), 2);
}

async function run(label, method, path, body) {
  if (busy) return;
  busy = true;
  refreshButtons();
  const url = `${location.origin}${path}`;
  const curl = method === "GET" ? `curl ${url}` : `curl -X POST ${url}${body ? ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(body)}'` : ""}`;
  $("t-req").textContent = `${method} ${path}${body ? `\n${JSON.stringify(body, null, 2)}` : ""}\n\n${curl}`;
  $("t-resp").textContent = "";
  $("t-status").hidden = true;
  const tx = $("t-tx");
  tx.replaceChildren(Object.assign(document.createElement("span"), { className: "wait", textContent: method === "GET" ? "Reading Stellar testnet" : `${label}: signing and sending to Stellar testnet` }));
  const t0 = performance.now();
  try {
    const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    const s = $("t-status");
    s.hidden = false;
    s.textContent = `${r.status}${j.error ? ` ${j.error.code}` : ""}`;
    s.className = `status ${r.ok ? "ok" : "bad"}`;
    $("t-resp").textContent = view(j);
    if (j.shipment?.key && j.shipment.registry) { ship = j.shipment; key = j.shipment.key; }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    tx.replaceChildren();
    if (j.tx?.hash) {
      if (j.call === "open") $("t-req").textContent += `\n\nkey ${j.shipment.key}`;
      tx.append(Object.assign(document.createElement("a"), { href: j.tx.explorer, target: "_blank", rel: "noopener", textContent: "See it on the explorer ↗" }),
        Object.assign(document.createElement("span"), { className: "hash", textContent: `tx ${short(j.tx.hash)} · ${secs} s` }));
    } else if (j.error?.refused_by === "custody_registry") {
      tx.append(Object.assign(document.createElement("strong"), { textContent: "Refused by the contract." }),
        Object.assign(document.createElement("span"), { className: "hash", textContent: `${j.error.message} No transaction was sent.` }));
    } else if (j.steps && j.shipment && j.head_matches === null) {
      tx.append(Object.assign(document.createElement("span"), { className: "hash", textContent: "Too old to recompute here: the testnet RPC keeps events about 7 days. Open a new shipment to verify." }));
    } else if (j.steps && j.shipment) {
      tx.replaceChildren(Object.assign(document.createElement("span"), { className: "wait", textContent: "Your browser is recomputing the head from Horizon and the contract" }));
      try {
        const v = await verifyInBrowser(j.shipment.registry, j.shipment.key, j.steps.map((x) => x.hash));
        const ok = v.recomputed === v.onchain;
        tx.replaceChildren(Object.assign(document.createElement("strong"), { textContent: ok ? "Record intact." : "Mismatch: the record does not match." }),
          Object.assign(document.createElement("span"), { className: "hash", textContent: `Your browser rebuilt the head from ${v.steps} transaction${v.steps === 1 ? "" : "s"} on Horizon and read the contract: ${short(v.recomputed ?? "none")} ${ok ? "=" : "≠"} ${short(v.onchain)}` }));
      } catch {
        tx.replaceChildren(Object.assign(document.createElement("span"), { className: "hash", textContent: `Server check: head_matches is ${j.head_matches}. The check in your browser could not reach Stellar testnet; try again.` }));
      }
    } else {
      tx.append(Object.assign(document.createElement("span"), { className: "hash", textContent: j.error?.message ?? `Read in ${secs} s.` }));
    }
    $("t-tag").textContent = r.ok ? "Live on testnet" : "Stellar testnet";
    $("t-tag").className = `tag${r.ok ? " live" : ""}`;
  } catch {
    tx.replaceChildren(Object.assign(document.createElement("span"), { className: "hash", textContent: "Could not reach the API. Check your connection and try again." }));
  } finally {
    busy = false;
    drawRoute();
    refreshButtons();
  }
}

$("b-open").addEventListener("click", () => { ship = null; key = null; drawRoute(); run("Open", "POST", "/api/sandbox/shipments"); });
$("b-hand").addEventListener("click", () => run("Handover", "POST", `/api/sandbox/shipments/${key}/handover`));
// a company two stops ahead claims to hand over: the registry refuses it on its own
$("b-wrong").addEventListener("click", () => run("Wrong company", "POST", `/api/sandbox/shipments/${key}/handover`, { from: ROLES[ship.seq + 2] }));
$("b-deliver").addEventListener("click", () => run("Deliver", "POST", `/api/sandbox/shipments/${key}/deliver`));
$("b-verify").addEventListener("click", () => run("Verify", "GET", `/api/shipments/${key}/history`));

drawRoute();
refreshButtons();
