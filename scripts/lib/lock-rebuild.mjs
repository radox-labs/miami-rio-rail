// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// O4: clean checkout of lock.commit, rebuild every non-legacy contract with the lock's flags and
// toolchain, compare sha256 with wasm_sha256. Fail-closed: any doubt is an error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildArgs, checkAgainstCrate } from "./lock-rules.mjs";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export function cacheRootOf(env = process.env) {
  // Rail-only cache: radox-core keeps its own pin in ~/.cache/radox-contracts.
  return env.RAIL_CONTRACTS_CACHE || path.join(os.homedir(), ".cache", "radox-contracts-rail");
}

export function repoUrlOf(lock, env = process.env) {
  return env.RADOX_CONTRACTS_REPO || `https://github.com/${lock.repo}.git`;
}

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv }).trim();
}

// Throws unless dir is the root of a git checkout at exactly `commit` with nothing changed or untracked.
export function verifyCheckout(dir, commit) {
  let top;
  try { top = git(dir, ["rev-parse", "--show-toplevel"]); } catch { throw new Error(`${dir}: not a git checkout`); }
  if (fs.realpathSync(top) !== fs.realpathSync(dir)) throw new Error(`${dir}: not the root of a git checkout (toplevel ${top})`);
  let head;
  try { head = git(dir, ["rev-parse", "HEAD"]); } catch { head = "(no HEAD)"; }
  if (head !== commit) throw new Error(`${dir}: HEAD ${head} != lock.commit ${commit}`);
  const dirty = git(dir, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"]);
  if (dirty) throw new Error(`${dir}: dirty tree:\n${dirty}`);
}

// Clone lock.commit into <cache>/<commit> once (atomic rename); an existing dir is checked, never repaired.
export function fetchPin(lock, { env = process.env, log = () => {} } = {}) {
  const root = cacheRootOf(env);
  const dir = path.join(root, lock.commit);
  if (fs.existsSync(dir)) {
    verifyCheckout(dir, lock.commit);
    log(`checkout ${lock.commit} already cached: ${dir}`);
    return dir;
  }
  fs.mkdirSync(root, { recursive: true });
  const tmp = fs.mkdtempSync(`${dir}.tmp-`);
  try {
    git(tmp, ["init", "-q"]);
    // Exact blob bytes, whatever the user's global core.autocrlf says.
    git(tmp, ["config", "core.autocrlf", "false"]);
    git(tmp, ["config", "core.eol", "lf"]);
    git(tmp, ["remote", "add", "origin", repoUrlOf(lock, env)]);
    try {
      git(tmp, ["fetch", "-q", "--depth", "1", "--no-tags", "origin", lock.commit]);
    } catch (e) {
      throw new Error(`git fetch ${lock.commit} from ${repoUrlOf(lock, env)} failed: ${String(e.stderr || e.message).trim()}`);
    }
    git(tmp, ["checkout", "-q", "--detach", lock.commit]);
    verifyCheckout(tmp, lock.commit);
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  verifyCheckout(dir, lock.commit);
  log(`checkout ${lock.commit} fetched: ${dir}`);
  return dir;
}

function firstLine(cmd, args, env) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim().split("\n")[0];
}

// Real builder: `stellar contract build` with RUSTUP_TOOLCHAIN = lock rustc; target and out dirs outside the checkout.
export function stellarBuild({ crateDir, args, rustc, targetDir, outDir, env = process.env }) {
  const runEnv = { ...env, RUSTUP_TOOLCHAIN: rustc, CARGO_TARGET_DIR: targetDir };
  execFileSync("stellar", [...args, "--out-dir", outDir], { cwd: crateDir, env: runEnv, stdio: ["ignore", "inherit", "inherit"] });
}

export function toolVersions(c, env = process.env) {
  const runEnv = { ...env, RUSTUP_TOOLCHAIN: c.rustc };
  return {
    rustc: firstLine("rustc", ["--version"], runEnv).split(" ")[1] ?? "",
    stellar_cli: firstLine("stellar", ["--version"], runEnv).split(" ")[1] ?? "",
  };
}

/**
 * Returns { dir, results: [{ name, status: ok|mismatch|error|legacy, want, got?, args?, error? }] }.
 * ok = every entry is ok or legacy. `builder` and `versions` are injectable for tests.
 */
export function rebuild(lock, { env = process.env, builder = stellarBuild, versions = toolVersions, log = () => {} } = {}) {
  const dir = fetchPin(lock, { env, log });
  const root = cacheRootOf(env);
  const results = [];
  for (const [name, c] of Object.entries(lock.contracts)) {
    const want = c.wasm_sha256;
    if (c.legacy) {
      results.push({ name, status: "legacy", want });
      continue;
    }
    try {
      const crateDir = path.join(dir, c.path);
      const cargoToml = fs.readFileSync(path.join(crateDir, "Cargo.toml"), "utf8");
      const tc = path.join(crateDir, "rust-toolchain.toml");
      const toolchainToml = fs.existsSync(tc) ? fs.readFileSync(tc, "utf8") : null;
      const crateErrs = checkAgainstCrate(name, c, { cargoToml, toolchainToml });
      if (crateErrs.length) throw new Error(crateErrs.join("; "));
      const v = versions(c, env);
      if (v.rustc !== c.rustc) throw new Error(`rustc ${v.rustc} != lock ${c.rustc} (rustup toolchain install ${c.rustc})`);
      if (v.stellar_cli !== c.stellar_cli) throw new Error(`stellar-cli ${v.stellar_cli} != lock ${c.stellar_cli}`);
      const args = buildArgs(c);
      const variant = c.features.length ? c.features.join("+") : "nodefault";
      const outDir = path.join(root, "out", lock.commit, `${name}-${variant}`);
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      builder({ crateDir, args, rustc: c.rustc, targetDir: path.join(root, "target", lock.commit, `${name}-${variant}`), outDir, env });
      verifyCheckout(dir, lock.commit); // the build must not touch the pinned tree
      const wasm = path.join(outDir, `${path.basename(c.path)}.wasm`);
      if (!fs.existsSync(wasm)) throw new Error(`build produced no ${wasm}`);
      const got = sha256(fs.readFileSync(wasm));
      results.push({ name, status: got === want ? "ok" : "mismatch", want, got, args: ["stellar", ...args].join(" ") });
    } catch (e) {
      results.push({ name, status: "error", want, error: e.message });
    }
  }
  return { dir, results };
}
