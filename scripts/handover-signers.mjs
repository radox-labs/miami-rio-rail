// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Show who authorised each handover and deliver, from the Soroban authorization entries in the
// saved transaction envelopes (proofs/tx/*.json). Explorers list only the envelope signature of the
// transaction source (the operator); the custodians sign authorization entries inside the call.
//
//   node scripts/handover-signers.mjs
// Exit 0 when every handover and deliver carries a signed address entry for both `from` and `to`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Networks, TransactionBuilder } from "@stellar/stellar-sdk";

const PROOF_FILE = process.env.PROOF_FILE ?? fileURLToPath(new URL("../proofs/lifecycle.json", import.meta.url)); // another proof file: its tx copies sit in tx/ beside it
const proof = JSON.parse(readFileSync(PROOF_FILE));
const names = Object.fromEntries(Object.entries(proof.actors).map(([n, g]) => [g, n]));
// the SDK's JSON form of XDR values names addresses as strings
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)));
const short = (g) => `${g.slice(0, 4)}…${g.slice(-4)}`;
let ok = true;

for (const step of proof.lifecycle.filter((s) => s.step === "handover" || s.step === "deliver")) {
  const saved = JSON.parse(readFileSync(join(dirname(PROOF_FILE), "tx", `${step.hash}.json`)));
  const tx = TransactionBuilder.fromXDR(saved.transaction.envelope_xdr, Networks.TESTNET);
  const op = tx.operations[0];
  const [from, to] = plain(op.func).invoke_contract.args.slice(1, 3).map((a) => a.address);
  const signed = op.auth
    .map((e) => { const c = plain(e.credentials); return c.address_v2 ?? c.address; })
    .filter((c) => c?.signature?.vec?.length)   // signed: a non-empty signature vector
    .map((c) => c.address);
  const both = signed.includes(from) && signed.includes(to);
  ok &&= both;
  console.log(`${step.step.padEnd(8)} ${step.hash.slice(0, 8)}  from ${names[from]} ${short(from)}  to ${names[to]} ${short(to)}  ` +
    `auth entries: ${signed.map((g) => names[g] ?? short(g)).join(", ")}  ${both ? "both signed" : "MISSING"}`);
}
console.log(ok ? "every handover and deliver: both custodians signed" : "MISSING signature");
process.exit(ok ? 0 : 1);
