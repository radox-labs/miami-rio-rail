// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Recompute a shipment's `head` from the arguments of its own transactions (read from Horizon,
// not from events, which the RPC keeps for about 7 days) and compare it with the contract's head.
//
//   node scripts/verify-head.mjs <key hex>             Horizon + on-chain head(key)
//   node scripts/verify-head.mjs <key hex> --offline   saved proofs/tx/*.json + head saved in the proof file
//   node scripts/verify-head.mjs --selftest            the fixed vector shared with the contract's unit test
// Exit 0 when the recomputed head matches.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { xdr, scValToNative, nativeToScVal, Keypair } from "@stellar/stellar-sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROOF_FILE = process.env.PROOF_FILE ?? join(ROOT, "proofs", "lifecycle.json"); // another proof file: its tx copies sit in tx/ beside it
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";

const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const be32 = (n) => { const b = Buffer.alloc(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const addrBytes = (g) => Buffer.from(nativeToScVal(g, { type: "address" }).toXDR());

// the head layout, byte for byte as in the contract
export const headOpen = (key, docsRoot) => sha(Buffer.from([0x01]), key, docsRoot);
export const headHandover = (head, from, to, evidence, seq, assurance) =>
  sha(Buffer.from([0x02]), head, addrBytes(from), addrBytes(to), evidence, be32(seq), be32(assurance));
export const headAttest = (head, source, kind, eventHash, seq) =>
  sha(Buffer.from([0x03]), head, addrBytes(source), be32(kind), eventHash, be32(seq));

function selftest() {
  const A = "GAUTZ4AOL3QBR4OAVXAECCQYQW6MZCTSQ45CUNNXYYIFQZFBGKPZVCLM";
  const B = "GAYOU2QZGAYOMTUHF6N3BO32ZYUEXL52IMJRBOOIRXN6MEOOOB3KERB3";
  const s = (t) => sha(Buffer.from(t));
  const key = s("TEST1234567|BRRIO");
  const h0 = headOpen(key, s("docs-root-v1"));
  const h1 = headHandover(h0, A, B, s("evidence-1"), 1, 3);
  const want = ["af078925b6df1601bd50a3a310c3db646311380940c87cc4d20979f32fbc472a",
    "4d27935042faa36a33b9c8726cdf96e8995ce7d33e0e7c0479e37fc14eaf8264",
    "7f75df7c846b6e6389ec1205819f64a0fe96a6d10d385322440973ca27a129f2"];
  const got = [key, h0, h1].map((b) => b.toString("hex"));
  got.forEach((g, i) => console.log(["key", "head after open", "head after handover"][i], g, g === want[i] ? "ok" : `MISMATCH (want ${want[i]})`));
  process.exit(got.every((g, i) => g === want[i]) ? 0 : 1);
}

async function txRecord(hash, offline) {
  const f = join(dirname(PROOF_FILE), "tx", `${hash}.json`);
  if (offline) {
    if (!existsSync(f)) throw new Error(`no saved copy proofs/tx/${hash}.json`);
    return JSON.parse(readFileSync(f, "utf8"));
  }
  const t = await fetch(`${HORIZON}/transactions/${hash}`);
  if (!t.ok) throw new Error(`Horizon ${t.status} for ${hash}`);
  const o = await fetch(`${HORIZON}/transactions/${hash}/operations`);
  return { transaction: await t.json(), operations: await o.json() };
}

const decode = (p) => xdr.ScVal.fromXDR(p.value, "base64");

async function onchainHead(registry, keyHex) {
  const { rpc, TransactionBuilder, Operation, Networks, Account } = await import("@stellar/stellar-sdk");
  const server = new rpc.Server(process.env.RPC_URL ?? "https://soroban-testnet.stellar.org");
  // a read needs no real account: simulate from a throwaway source
  const src = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(src, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: registry, function: "head",
      args: [nativeToScVal(Buffer.from(keyHex, "hex"), { type: "bytes" })] }))
    .setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`head(key): ${sim.error.split("\n")[0]}`);
  return Buffer.from(scValToNative(sim.result.retval)).toString("hex");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selftest();
  const offline = args.includes("--offline");
  const keyHex = args.find((a) => !a.startsWith("--"));
  if (!keyHex || !/^[0-9a-f]{64}$/.test(keyHex)) {
    console.error("usage: verify-head.mjs <key hex> [--offline] | --selftest");
    process.exit(2);
  }
  const proof = JSON.parse(readFileSync(PROOF_FILE, "utf8"));
  const registry = proof.custody_registry;
  const hashes = [...proof.lifecycle.map((x) => x.hash), ...(proof.attest ?? []).map((x) => x.hash)];

  // keep successful txs only, in ledger order
  const recs = [];
  for (const h of hashes) {
    const r = await txRecord(h, offline);
    if (!r.transaction.successful) continue;
    for (const op of r.operations._embedded.records) {
      if (op.type !== "invoke_host_function" || !op.parameters) continue;
      // parameters = [contract address, function-name Symbol, arg0, arg1, ...]
      const contract = scValToNative(decode(op.parameters[0]));
      if (contract !== registry) continue;
      recs.push({ ledger: r.transaction.ledger, order: r.transaction.application_order ?? 0,
        paging: BigInt(op.paging_token), fn: scValToNative(decode(op.parameters[1])),
        args: op.parameters.slice(2).map(decode), hash: h });
    }
  }
  recs.sort((a, b) => a.ledger - b.ledger || a.order - b.order || (a.paging < b.paging ? -1 : 1));

  let head = null;
  let seq = 0;
  for (const r of recs) {
    const a = r.args.map((v) => scValToNative(v));
    const k = Buffer.from(a[0]).toString("hex");
    if (k !== keyHex) continue;
    if (r.fn === "open") { head = headOpen(Buffer.from(a[0]), Buffer.from(a[3])); seq = 0; }
    else if (r.fn === "handover") { seq += 1; head = headHandover(head, a[1], a[2], Buffer.from(a[3]), seq, a[4]); }
    else if (r.fn === "attest") head = headAttest(head, a[1], a[2], Buffer.from(a[3]), seq);
    else continue; // deliver, freeze, unfreeze do not change head
    console.log(`${r.fn.padEnd(8)} ledger ${r.ledger} ${r.hash.slice(0, 12)}… seq ${seq} head ${head.toString("hex")}`);
  }
  if (!head) { console.log("no open transaction for this key in proofs/lifecycle.json"); process.exit(1); }

  const want = offline ? (proof.shipments?.find((s) => s.key === keyHex) ?? proof.shipment)?.final_head : await onchainHead(registry, keyHex);
  const got = head.toString("hex");
  console.log(`recomputed ${got}`);
  console.log(`${offline ? "saved     " : "on-chain  "} ${want}`);
  console.log(got === want ? "MATCH" : "MISMATCH");
  process.exit(got === want ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
