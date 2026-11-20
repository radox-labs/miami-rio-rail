// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Reads contracts.lock.json (repo root): the radox-contracts commit and wasm hashes this repo uses.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFor, lintLock } from "./lock-rules.mjs";

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
// be built for it, and mainnet takes only a reproducible, non-legacy entry.
export function wasmHash(name, { network } = {}) {
  return hashFor(lock, name, { network });
}
