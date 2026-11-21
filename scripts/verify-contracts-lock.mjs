// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Checks contracts.lock.json. Every mode first applies the static rules (scripts/lib/lock-rules.mjs):
// exact features without `testing`, --no-default-features, network per entry, legacy marked.
//
//   node scripts/verify-contracts-lock.mjs            chain: every contract ID runs wasm_sha256 (read-only RPC)
//   node scripts/verify-contracts-lock.mjs --rebuild  clean checkout of lock.commit, rebuild, compare sha256
//   node scripts/verify-contracts-lock.mjs --static   static rules only (offline)
// Options: --lock <file> (default: repo contracts.lock.json), --report <file> (JSON result).
// Env: TESTNET_RPC_URL, MAINNET_RPC_URL (chain); RAIL_CONTRACTS_CACHE, RADOX_CONTRACTS_REPO (rebuild).
// Exit code 1 on any rule violation, mismatch or read/build error. Legacy entries only warn.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lintLock } from "./lib/lock-rules.mjs";

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const mode = argv.includes("--rebuild") ? "rebuild" : argv.includes("--static") ? "static" : "chain";
const lockPath = opt("--lock") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "contracts.lock.json");
const reportPath = opt("--report");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const report = { mode, repo: lock.repo, commit: lock.commit, lock_sha256: sha(fs.readFileSync(lockPath)) };
const done = (bad) => {
  if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify({ ...report, ok: !bad }, null, 2)}\n`);
  process.exit(bad ? 1 : 0);
};

console.log(`lock: ${lock.repo}@${lock.commit} (${mode})`);
const { errors, warnings } = lintLock(lock);
for (const w of warnings) console.log(`WARN ${w}`);
for (const e of errors) console.log(`XX ${e}`);
report.lint = { errors, warnings };
if (errors.length) { console.log(`${errors.length} lock rule violation(s)`); done(true); }

let bad = 0;
if (mode === "static") {
  console.log("lock rules ok");
} else if (mode === "rebuild") {
  const { rebuild } = await import("./lib/lock-rebuild.mjs");
  let res;
  try {
    res = rebuild(lock, { log: (m) => console.log(m) });
  } catch (e) {
    console.log(`XX checkout: ${e.message}`);
    report.error = e.message;
    done(true);
  }
  report.checkout = res.dir;
  report.results = res.results;
  for (const r of res.results) {
    if (r.status === "ok") console.log(`ok ${r.name} ${r.got} (${r.args})`);
    else if (r.status === "legacy") console.log(`WARN ${r.name} legacy, not rebuilt; lock keeps installed wasm ${r.want}`);
    else if (r.status === "mismatch") { bad++; console.log(`XX ${r.name} ${r.got} != lock ${r.want} (${r.args})`); }
    else { bad++; console.log(`!! ${r.name} ${r.error}`); }
  }
  console.log(bad ? `${bad} problem(s)` : `every non-legacy wasm rebuilt from ${lock.commit} matches the lock`);
} else {
  // Loaded here so --static and --rebuild run without node_modules.
  const { rpc } = await import("@stellar/stellar-sdk");
  const RPC = {
    testnet: process.env.TESTNET_RPC_URL ?? "https://soroban-testnet.stellar.org",
    mainnet: process.env.MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com",
  };
  const servers = Object.fromEntries(Object.entries(RPC).map(([n, u]) => [n, new rpc.Server(u)]));
  report.results = [];
  for (const [name, c] of Object.entries(lock.contracts)) {
    const want = c.wasm_sha256;
    for (const [network, ids] of Object.entries(c.deployments ?? {})) {
      const server = servers[network];
      if (!server) { console.log(`?  ${name} ${network}: no RPC configured`); bad++; continue; }
      for (const [label, id] of Object.entries(ids)) {
        try {
          const got = sha(await server.getContractWasmByContractId(id));
          const ok = got === want;
          if (!ok) bad++;
          report.results.push({ name, network, label, id, got, ok });
          console.log(`${ok ? "ok" : "XX"} ${name} ${network}/${label} ${id} ${got}${ok ? "" : ` != ${want}`}`);
        } catch (e) {
          bad++;
          report.results.push({ name, network, label, id, error: e.message });
          console.log(`!! ${name} ${network}/${label} ${id} read failed: ${e.message}`);
        }
      }
    }
  }
  console.log(bad ? `${bad} problem(s)` : "all contract IDs match the lock");
}
done(bad);
