// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Reads contracts.lock.json (repo root): the radox-contracts commit and wasm hashes this repo uses.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts.lock.json");
export const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));

export function contract(name) {
  const c = lock.contracts?.[name];
  if (!c) throw new Error(`contracts.lock.json: no entry for ${name}`);
  return c;
}

// sha256 of the wasm, lowercase hex, as installed on chain
export function wasmHash(name) {
  const h = contract(name).wasm_sha256;
  if (!/^[0-9a-f]{64}$/.test(h ?? "")) throw new Error(`contracts.lock.json: bad wasm_sha256 for ${name}`);
  return h;
}
