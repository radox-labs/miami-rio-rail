// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Write page/snapshot.json: the two shipment proofs (proofs/lifecycle.json, proofs/three-machine.json)
// plus, per transaction, only the Horizon fields the page reads. The page shows it, labelled
// "snapshot, not live", when testnet cannot be reached.
//   node scripts/page-snapshot.mjs
import { readFileSync, writeFileSync } from "node:fs";

const shipments = ["proofs/lifecycle.json", "proofs/three-machine.json"].map((f) => JSON.parse(readFileSync(f, "utf8")));
const hashes = shipments.flatMap((p) => [...p.lifecycle, ...(p.attest ?? [])].map((x) => x.hash));
const tx = Object.fromEntries(hashes.map((h) => {
  const r = JSON.parse(readFileSync(`proofs/tx/${h}.json`, "utf8"));
  const { successful, ledger, application_order, created_at } = r.transaction;
  const records = r.operations._embedded.records.map(({ type, parameters, paging_token }) => ({ type, parameters, paging_token }));
  return [h, { transaction: { successful, ledger, application_order, created_at }, operations: { _embedded: { records } } }];
}));
writeFileSync("page/snapshot.json", JSON.stringify({ shipments, tx }) + "\n");
