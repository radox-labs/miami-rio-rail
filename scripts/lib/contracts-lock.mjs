// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Reads contracts.lock.json (repo root): the radox-contracts commit and wasm hashes this repo uses.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFor, lintLock } from "./lock-rules.mjs";
import { requireRebuilt } from "./lock-rebuild.mjs";

export const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts.lock.json");
export const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));

export function contract(name) {
  // Never hand out an entry from a lock that breaks the rules (e.g. a `testing` build).
  const { errors } = lintLock(lock);
  if (errors.length) throw new Error(`contracts.lock.json refused: ${errors.join("; ")}`);
  const c = lock.contracts?.[name];
  if (!c) throw new Error(`contracts.lock.json: no entry for ${name}`);
  return c;
}

// sha256 of the wasm, lowercase hex, as installed on chain. `network` is required: the entry must
// be built for it, and mainnet takes only a reproducible, non-legacy entry that a rebuild of the
// whole lock from a clean checkout confirms (scripts/lib/lock-rebuild.mjs; once per process).
const rebuilt = new Map();
export function wasmHash(name, { network } = {}) {
  const h = hashFor(lock, name, { network });
  if (network !== "mainnet") return h;
  if (!rebuilt.has(name)) {
    process.stderr.write(`[contracts-lock] mainnet: rebuilding ${lock.repo}@${lock.commit} before using ${name}\n`);
    rebuilt.set(name, requireRebuilt(lock, name, { log: (m) => process.stderr.write(`[contracts-lock] ${m}\n`) }));
  }
  if (rebuilt.get(name) !== h) throw new Error(`contracts.lock.json: rebuilt ${name} ${rebuilt.get(name)} != lock ${h}`);
  process.stderr.write(`[contracts-lock] mainnet: ${name} rebuilt from ${lock.commit} = ${h}\n`);
  return h;
}
