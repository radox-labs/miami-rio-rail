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

// Hermetic git: no GIT_* from the caller (GIT_DIR, GIT_OBJECT_DIRECTORY…), no global/system config
// (filters, attributes), no replace objects. What is read is what the commit sha names.
export function gitEnvOf(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_")));
  return { ...clean, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
const gitEnv = gitEnvOf();
function git(dir, args, input) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"], env: gitEnv, maxBuffer: 1 << 26 }).trim();
}

// Throws unless dir is the root of a git checkout at exactly `commit` with nothing changed or untracked.
export function verifyCheckout(dir, commit) {
  let top;
  try { top = git(dir, ["rev-parse", "--show-toplevel"]); } catch { throw new Error(`${dir}: not a git checkout`); }
  if (fs.realpathSync(top) !== fs.realpathSync(dir)) throw new Error(`${dir}: not the root of a git checkout (toplevel ${top})`);
  // Nothing may substitute objects: replace refs, grafts, alternates, a .git that points elsewhere.
  const gd = path.join(dir, ".git");
  const st = fs.lstatSync(gd, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new Error(`${dir}: .git is not a plain directory`);
  const replaced = git(dir, ["for-each-ref", "--format=%(refname)", "refs/replace/"]);
  if (replaced) throw new Error(`${dir}: replace refs present (git replace):\n${replaced}`);
  for (const f of ["info/grafts", "objects/info/alternates", "objects/info/http-alternates"]) {
    if (fs.existsSync(path.join(gd, f))) throw new Error(`${dir}: unexpected .git/${f}`);
  }
  const shallow = path.join(gd, "shallow");
  if (fs.existsSync(shallow) && fs.readFileSync(shallow, "utf8").trim() !== commit) {
    throw new Error(`${dir}: unexpected .git/shallow (only ${commit} may be a shallow root)`);
  }
  let head;
  try { head = git(dir, ["rev-parse", "HEAD"]); } catch { head = "(no HEAD)"; }
  if (head !== commit) throw new Error(`${dir}: HEAD ${head} != lock.commit ${commit}`);
  // Every object hashes to its name (a swapped loose object fails here).
  try { git(dir, ["fsck", "--full", "--strict", "--no-dangling", "--no-progress"]); } catch (e) {
    throw new Error(`${dir}: git fsck failed: ${String(e.stderr || e.message).trim()}`);
  }
  // Extra files, ignored ones included (an ignored .cargo/config.toml would change the build).
  const dirty = git(dir, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]);
  if (dirty) throw new Error(`${dir}: dirty tree:\n${dirty}`);
  // Content, not stat data: each tracked file must hash to the blob of the commit.
  const entries = git(dir, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]).split("\0").filter(Boolean)
    .map((l) => { const [meta, file] = l.split("\t"); const [mode, type, oid] = meta.split(" "); return { mode, type, oid, file }; });
  const bad = entries.filter((e) => e.type !== "blob").map((e) => `${e.file} (${e.type})`);
  const files = entries.filter((e) => e.type === "blob" && e.mode !== "120000");
  const hashes = files.length ? git(dir, ["hash-object", "--no-filters", "--stdin-paths"], files.map((e) => e.file).join("\n") + "\n").split("\n") : [];
  files.forEach((e, i) => { if (hashes[i] !== e.oid) bad.push(`${e.file} content ${hashes[i]} != ${e.oid}`); });
  for (const e of entries.filter((x) => x.mode === "120000")) {
    const oid = git(dir, ["hash-object", "--stdin"], fs.readlinkSync(path.join(dir, e.file)));
    if (oid !== e.oid) bad.push(`${e.file} symlink ${oid} != ${e.oid}`);
  }
  if (bad.length) throw new Error(`${dir}: checkout differs from ${commit}:\n${bad.join("\n")}`);
}

// Clone lock.commit into <cache>/<commit> once (atomic rename); an existing dir is checked, never repaired.
export function fetchPin(lock, { env = process.env, log = () => {}, root = cacheRootOf(env) } = {}) {
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

// Build environment by allowlist: nothing else from the caller (RUSTFLAGS, RUSTC_WRAPPER,
// CARGO_BUILD_*, CARGO_TARGET_*, CARGO_PROFILE_*, CARGO_ENCODED_RUSTFLAGS… all change the bytes).
const BUILD_ENV_KEEP = ["PATH", "HOME", "CARGO_HOME", "RUSTUP_HOME"];
export function buildEnvOf(env, rustc, extra = {}) {
  const out = {};
  for (const k of BUILD_ENV_KEEP) if (env[k] != null) out[k] = env[k];
  return { ...out, RUSTUP_TOOLCHAIN: rustc, ...extra };
}

export function cargoHomeOf(env = process.env) {
  return env.CARGO_HOME || path.join(env.HOME || os.homedir(), ".cargo");
}

// Cargo merges .cargo/config(.toml) from every ancestor of the crate and from CARGO_HOME. Inside the
// checkout such a file is tracked source (verified by verifyCheckout); above it, or in CARGO_HOME, it is
// machine state that can change the build, so it is refused (not warned: a warning would still let a
// forged hash through the mainnet gate). Run with a clean CARGO_HOME if yours has a config.
export function checkCargoConfig(checkoutDir, env = process.env) {
  const found = [];
  let d = path.dirname(fs.realpathSync(checkoutDir));
  for (;;) {
    for (const f of ["config", "config.toml"]) if (fs.existsSync(path.join(d, ".cargo", f))) found.push(path.join(d, ".cargo", f));
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  for (const f of ["config", "config.toml"]) if (fs.existsSync(path.join(cargoHomeOf(env), f))) found.push(path.join(cargoHomeOf(env), f));
  if (found.length) throw new Error(`cargo config outside the pinned source would change the build: ${[...new Set(found)].join(", ")} (move it, or set CARGO_HOME to a clean dir)`);
}

// Real builder: `stellar contract build` with RUSTUP_TOOLCHAIN = lock rustc; target and out dirs outside the checkout.
export function stellarBuild({ crateDir, args, rustc, targetDir, outDir, env = process.env }) {
  const runEnv = buildEnvOf(env, rustc, { CARGO_TARGET_DIR: targetDir });
  execFileSync("stellar", [...args, "--out-dir", outDir], { cwd: crateDir, env: runEnv, stdio: ["ignore", "inherit", "inherit"] });
}

export function toolVersions(c, env = process.env) {
  const runEnv = buildEnvOf(env, c.rustc);
  return {
    rustc: firstLine("rustc", ["--version"], runEnv).split(" ")[1] ?? "",
    stellar_cli: firstLine("stellar", ["--version"], runEnv).split(" ")[1] ?? "",
  };
}

/**
 * Returns { dir, results: [{ name, status: ok|mismatch|error|legacy, want, got?, args?, error? }] }.
 * ok = every entry is ok or legacy. `builder` and `versions` are injectable for tests.
 */
// Private parent for the gate's fresh checkouts: ~/.cache/radox-rail-gate, mode 0700, ours.
// Never TMPDIR (/tmp is shared, and cargo reads .cargo/config.toml from every parent dir).
export function gateRootOf(env = process.env) {
  const dir = path.join(env.HOME || os.homedir(), ".cache", "radox-rail-gate");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bad = () => new Error(`${dir} must be a directory owned by you with mode 0700`);
  let st = fs.lstatSync(dir); // lstat: a symlink is refused, never followed
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw bad();
  fs.chmodSync(dir, 0o700);
  st = fs.lstatSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077)) throw bad();
  return dir;
}

// fresh: true = new mkdtemp checkout and build dirs, no cache (the mainnet gate), removed afterwards.
export function rebuild(lock, { env = process.env, builder = stellarBuild, versions = toolVersions, log = () => {}, fresh = false } = {}) {
  const root = fresh ? fs.mkdtempSync(path.join(gateRootOf(env), "run-")) : cacheRootOf(env);
  try {
    return rebuildIn(root, lock, { env, builder, versions, log });
  } finally {
    if (fresh) fs.rmSync(root, { recursive: true, force: true });
  }
}

function rebuildIn(root, lock, { env, builder, versions, log }) {
  const dir = fetchPin(lock, { env, log, root });
  checkCargoConfig(dir, env);
  const results = [];
  for (const [name, c] of Object.entries(lock.contracts)) {
    const want = c.wasm_sha256;
    if (c.legacy) {
      results.push({ name, status: "legacy", want });
      continue;
    }
    try {
      const crateDir = path.join(dir, c.path);
      // The crate must resolve inside the pinned checkout (no `..`, absolute path or symlink out).
      const real = fs.realpathSync(crateDir);
      const realRoot = fs.realpathSync(dir);
      if (path.relative(realRoot, real).startsWith("..") || path.isAbsolute(path.relative(realRoot, real))) {
        throw new Error(`${c.path} resolves to ${real}, outside the checkout ${realRoot}`);
      }
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
      // Fresh target and out dirs per run: no artifact from an earlier build can be measured.
      fs.mkdirSync(path.join(root, "runs"), { recursive: true });
      const run = fs.mkdtempSync(path.join(root, "runs", `${lock.commit.slice(0, 12)}-${name}-${variant}-`));
      const outDir = path.join(run, "out");
      fs.mkdirSync(outDir);
      const started = Date.now();
      try {
        builder({ crateDir, args, rustc: c.rustc, targetDir: path.join(run, "target"), outDir, env });
      } finally {
        verifyCheckout(dir, lock.commit); // the build must not touch the pinned tree
      }
      const wasm = path.join(outDir, `${path.basename(c.path)}.wasm`);
      if (!fs.existsSync(wasm)) throw new Error(`build produced no ${wasm}`);
      if (fs.statSync(wasm).mtimeMs + 1000 < started) throw new Error(`${wasm} is older than this build`);
      const got = sha256(fs.readFileSync(wasm));
      results.push({ name, status: got === want ? "ok" : "mismatch", want, got, args: ["stellar", ...args].join(" ") });
      fs.rmSync(run, { recursive: true, force: true });
    } catch (e) {
      results.push({ name, status: "error", want, error: e.message });
    }
  }
  return { dir, results };
}

// Mainnet gate: rebuild the whole lock from a clean checkout and require every non-legacy entry,
// and `name` itself, to match. Throws otherwise. A static edit of the lock (a hash swapped in,
// an entry flipped to non-legacy) passes lintLock but never passes this.
export function requireRebuilt(lock, name, opts = {}) {
  const { results } = rebuild(lock, { ...opts, fresh: true }); // never the cache
  const bad = results.filter((r) => r.status !== "ok" && r.status !== "legacy");
  const mine = results.find((r) => r.name === name);
  if (bad.length || mine?.status !== "ok") {
    const why = [...bad, ...(mine && mine.status !== "ok" && !bad.includes(mine) ? [mine] : [])]
      .map((r) => `${r.name} ${r.status}${r.got ? ` ${r.got} != lock ${r.want}` : ""}${r.error ? ` ${r.error}` : ""}`);
    throw new Error(`contracts.lock.json: rebuild from ${lock.commit} does not match the lock (${why.join("; ") || `${name} missing`}); nothing sent`);
  }
  return mine.got;
}
