// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Static rules for contracts.lock.json (no network, no checkout) and helpers that read the
// pinned crate (Cargo.toml features, rust-toolchain.toml). Used by verify-contracts-lock.mjs.

export const NETWORKS = ["testnet", "mainnet"];
// Only these entries may be kept as legacy (decision G, 16/11); custody_registry cannot be demoted.
export const LEGACY_ALLOWED = ["transfer_agent"];
// Test-only switches, matched on every feature name in the closure (case-insensitive).
const TEST_FEATURE = /(^|[/:])(testing|testutils)$/i;
const CRATE_PATH = /^contracts\/[A-Za-z0-9_-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

// Returns { errors: string[], warnings: string[] }. Any error means the lock is refused.
export function lintLock(lock) {
  const errors = [];
  const warnings = [];
  if (!HEX40.test(lock?.commit ?? "")) errors.push(`commit must be a full 40-hex sha (got ${lock?.commit})`);
  if (typeof lock?.repo !== "string" || !lock.repo) errors.push("repo missing");
  const entries = Object.entries(lock?.contracts ?? {});
  if (!entries.length) errors.push("no contracts");
  for (const [name, c] of entries) {
    const e = (m) => errors.push(`${name}: ${m}`);
    if ("reproducible_from_commit" in c) e("reproducible_from_commit is no longer accepted; use `reproducible` (checked by --rebuild)");
    if (typeof c.legacy !== "boolean") e("legacy must be true or false");
    if (typeof c.reproducible !== "boolean") e("reproducible must be true or false");
    if (!HEX64.test(c.wasm_sha256 ?? "")) e("bad wasm_sha256");
    for (const k of ["path", "rustc", "stellar_cli"]) if (typeof c[k] !== "string" || !c[k]) e(`${k} missing`);
    if (typeof c.path === "string" && !CRATE_PATH.test(c.path)) e(`path ${c.path} must match contracts/<crate>`);

    if (!Array.isArray(c.network) || !c.network.length) e("network must be a non-empty list");
    else for (const n of c.network) if (!NETWORKS.includes(n)) e(`unknown network ${n}`);
    for (const n of Object.keys(c.deployments ?? {})) {
      if (!Array.isArray(c.network) || !c.network.includes(n)) e(`deployment on ${n} but network is ${JSON.stringify(c.network)}`);
    }

    if (Array.isArray(c.features)) {
      for (const f of c.features) {
        if (typeof f !== "string") continue;
        if (TEST_FEATURE.test(f)) e(`features include test-only \`${f}\` (e.g. token_sale skips USDC SAC validation)`);
        else if (f === "default") e("features include `default`, which turns the crate defaults (`testing`) back on");
      }
    }

    if (c.legacy === true) {
      if (!LEGACY_ALLOWED.includes(name)) e(`only ${LEGACY_ALLOWED.join(", ")} may be legacy`);
      // Legacy = an installed wasm kept as-is (decision G, 16/11); never a way around the rules.
      if (c.reproducible !== false) e("a legacy entry must have reproducible: false");
      if (c.features !== null) e("a legacy entry must have features: null (its build flags are not known)");
      if (c.no_default_features !== null) e("a legacy entry must have no_default_features: null");
      if (Array.isArray(c.network) && c.network.includes("mainnet")) e("a legacy entry cannot target mainnet");
      if (c.deployments?.mainnet) e("a legacy entry cannot have mainnet deployments");
      warnings.push(`${name}: legacy wasm ${c.wasm_sha256}, not reproducible from ${lock.commit} (features unknown)`);
    } else if (c.legacy === false) {
      if (c.reproducible !== true) e("a non-legacy entry must be reproducible: true");
      if (!Array.isArray(c.features) || !c.features.every((f) => typeof f === "string" && /^[\w-]+$/.test(f))) e("features must be an exact list of feature names");
      // Allowlist, decidable without the source: the only build switch these crates need is the
      // network feature (token_sale: testnet/mainnet), matching the entry's single network.
      // --rebuild also checks the transitive closure in the crate's Cargo.toml.
      else for (const f of c.features) {
        if (!NETWORKS.includes(f)) e(`feature ${f} is not allowed (only the network feature: ${NETWORKS.join(", ")})`);
        else if (!(Array.isArray(c.network) && c.network.length === 1 && c.network[0] === f)) e(`feature ${f} needs network ["${f}"] (one entry per network)`);
      }
      // Always explicit: the crate defaults (token_sale, transfer_agent: default = ["testing"]) never apply.
      if (c.no_default_features !== true) e("no_default_features must be true (crate defaults may include `testing`)");
    }
  }
  return { errors, warnings };
}

// Exact build arguments for a lock entry (non-legacy).
export function buildArgs(c) {
  const args = ["contract", "build", "--locked", "--no-default-features"];
  if (c.features.length) args.push("--features", c.features.join(","));
  return args;
}

// Minimal TOML reader for the [features] table: { name: [deps] }. Enough for Cargo.toml.
export function cargoFeatures(toml) {
  const out = {};
  let inFeatures = false;
  let buf = "";
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (/^\[/.test(line) && !buf) { inFeatures = line === "[features]"; continue; }
    if (!inFeatures || !line) continue;
    buf += ` ${line}`;
    const m = buf.match(/^\s*([\w-]+)\s*=\s*\[([^\]]*)\]\s*$/);
    if (m) {
      out[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
      buf = "";
    } else if (!buf.includes("[")) {
      throw new Error(`cannot parse [features] line: ${line}`);
    }
  }
  if (buf) throw new Error(`unterminated [features] entry: ${buf.trim()}`);
  return out;
}

// Every feature switched on by `start`, following crate features (`a = ["b"]`), `dep:x` and `x/feat`.
export function featureClosure(feats, start) {
  const seen = new Set();
  const todo = [...start];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (f in feats) todo.push(...feats[f]);
  }
  return [...seen].sort();
}

// Hash a script may use on `network`. Mainnet only from a reproducible, non-legacy entry.
export function hashFor(lock, name, { network } = {}) {
  const { errors } = lintLock(lock);
  if (errors.length) throw new Error(`contracts.lock.json refused: ${errors.join("; ")}`);
  const c = lock.contracts?.[name];
  if (!c) throw new Error(`contracts.lock.json: no entry for ${name}`);
  if (!NETWORKS.includes(network)) throw new Error(`wasmHash(${name}): pass { network: "testnet" | "mainnet" }`);
  if (!c.network.includes(network)) throw new Error(`contracts.lock.json: ${name} is not built for ${network} (network ${JSON.stringify(c.network)})`);
  if (network === "mainnet" && (c.legacy || !c.reproducible)) throw new Error(`contracts.lock.json: ${name} is legacy or not reproducible; never on mainnet`);
  return c.wasm_sha256;
}

export function toolchainChannel(toml) {
  return toml.match(/^\s*channel\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

// Rules that need the crate source at lock.commit. Returns a list of errors.
export function checkAgainstCrate(name, c, { cargoToml, toolchainToml }) {
  const errs = [];
  let feats;
  try { feats = cargoFeatures(cargoToml); } catch (err) { return [`${name}: Cargo.toml: ${err.message}`]; }
  for (const f of c.features) if (!(f in feats)) errs.push(`${name}: feature ${f} is not declared in Cargo.toml`);
  const closure = featureClosure(feats, c.no_default_features === true ? c.features : ["default", ...c.features]);
  const bad = closure.filter((f) => TEST_FEATURE.test(f) || f === "default");
  if (bad.length) errs.push(`${name}: features ${JSON.stringify(c.features)} turn on ${bad.join(", ")} (closure: ${closure.join(", ")})`);
  if ((feats.default ?? []).includes("testing") && c.no_default_features !== true) {
    errs.push(`${name}: crate default includes \`testing\` and the entry does not pass --no-default-features`);
  }
  // Crates with network features (token_sale: testnet/mainnet) build one variant per network.
  const netFeats = NETWORKS.filter((n) => n in feats);
  if (netFeats.length) {
    if (c.network.length !== 1) errs.push(`${name}: crate has network features (${netFeats.join(", ")}); one entry per network`);
    else if (netFeats.includes(c.network[0]) && !c.features.includes(c.network[0])) errs.push(`${name}: network ${c.network[0]} needs feature ${c.network[0]}`);
    for (const f of c.features) if (NETWORKS.includes(f) && f !== c.network[0]) errs.push(`${name}: feature ${f} does not match network ${c.network}`);
  }
  if (toolchainToml != null) {
    const ch = toolchainChannel(toolchainToml);
    if (ch !== c.rustc) errs.push(`${name}: rust-toolchain.toml channel ${ch} != lock rustc ${c.rustc}`);
  }
  return errs;
}
