// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Read-only check: every contract ID in contracts.lock.json runs the wasm the lock names.
// Fetches each contract's wasm from RPC, hashes it and compares with wasm_sha256. Sends nothing.
//
//   node scripts/verify-contracts-lock.mjs
// Optional env: TESTNET_RPC_URL, MAINNET_RPC_URL. Exit code 1 on any mismatch or read error.
import { createHash } from "node:crypto";
import { rpc } from "@stellar/stellar-sdk";
import { lock, wasmHash } from "./lib/contracts-lock.mjs";

const RPC = {
  testnet: process.env.TESTNET_RPC_URL ?? "https://soroban-testnet.stellar.org",
  mainnet: process.env.MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com",
};
const servers = Object.fromEntries(Object.entries(RPC).map(([n, u]) => [n, new rpc.Server(u)]));
const sha = (b) => createHash("sha256").update(b).digest("hex");

console.log(`lock: ${lock.repo}@${lock.commit}`);
let bad = 0;
for (const name of Object.keys(lock.contracts)) {
  const want = wasmHash(name);
  for (const [network, ids] of Object.entries(lock.contracts[name].deployments ?? {})) {
    const server = servers[network];
    if (!server) { console.log(`?  ${name} ${network}: no RPC configured`); bad++; continue; }
    for (const [label, id] of Object.entries(ids)) {
      try {
        const got = sha(await server.getContractWasmByContractId(id));
        const ok = got === want;
        if (!ok) bad++;
        console.log(`${ok ? "ok" : "XX"} ${name} ${network}/${label} ${id} ${got}${ok ? "" : ` != ${want}`}`);
      } catch (e) {
        bad++;
        console.log(`!! ${name} ${network}/${label} ${id} read failed: ${e.message}`);
      }
    }
  }
}
console.log(bad ? `${bad} problem(s)` : "all contract IDs match the lock");
process.exit(bad ? 1 : 0);
