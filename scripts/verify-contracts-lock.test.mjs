// verify-contracts-lock: static rules (O5) and --rebuild (O4), run through the CLI for exit codes.
// Run: node --test scripts/verify-contracts-lock.test.mjs (no network, no cargo: fake stellar/rustc).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cargoFeatures, checkAgainstCrate, lintLock } from "./lib/lock-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "verify-contracts-lock.mjs");
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, "..", "contracts.lock.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lockv-"));
const sha = (s) => createHash("sha256").update(s).digest("hex");

function run(lock, args = ["--static"], env = {}) {
  const dir = tmp();
  const file = path.join(dir, "lock.json");
  fs.writeFileSync(file, JSON.stringify(lock));
  const r = spawnSync(process.execPath, [CLI, ...args, "--lock", file, "--report", path.join(dir, "r.json")], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
  const report = fs.existsSync(path.join(dir, "r.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "r.json"), "utf8")) : null;
  return { code: r.status, out: r.stdout + r.stderr, report };
}

test("the real lock passes the static rules, legacy only warns", () => {
  const r = run(REAL);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARN transfer_agent: legacy/);
});

// Family: every mutation applied to every entry of the real lock must be refused.
const MUTATIONS = {
  "testing in features": (c) => { c.features = [...(c.features ?? []), "testing"]; },
  "only testing": (c) => { c.features = ["testing"]; },
  "crate defaults (no --no-default-features)": (c) => { c.no_default_features = false; },
  "no_default_features missing": (c) => { delete c.no_default_features; },
  "features missing": (c) => { delete c.features; },
  "features not a list": (c) => { c.features = "testnet"; },
  "old hand-written field": (c) => { c.reproducible_from_commit = true; },
  "network missing": (c) => { delete c.network; },
  "network empty": (c) => { c.network = []; },
  "unknown network": (c) => { c.network = ["futurenet"]; },
  "deployment outside network": (c) => { c.network = c.network.filter((n) => n !== Object.keys(c.deployments)[0]); if (!c.network.length) c.network = ["mainnet"]; },
  "legacy not boolean": (c) => { c.legacy = "no"; },
  "reproducible missing": (c) => { delete c.reproducible; },
  "legacy flag flipped": (c) => { c.legacy = !c.legacy; },
  "reproducible flipped": (c) => { c.reproducible = !c.reproducible; },
  "bad wasm hash": (c) => { c.wasm_sha256 = c.wasm_sha256.slice(1); },
  "rustc missing": (c) => { delete c.rustc; },
};
for (const name of Object.keys(REAL.contracts)) {
  for (const [label, mutate] of Object.entries(MUTATIONS)) {
    test(`refuses ${name}: ${label}`, () => {
      const lock = clone(REAL);
      mutate(lock.contracts[name]);
      const r = run(lock);
      assert.notEqual(r.code, 0, `${label} on ${name} was accepted:\n${r.out}`);
      assert.match(r.out, /lock rule violation/);
    });
  }
}

test("legacy cannot be used as a way around the rules", () => {
  const base = clone(REAL.contracts.transfer_agent);
  const cases = {
    "legacy with testing": { features: ["testing"] },
    "legacy with a feature list": { features: [] },
    "legacy on mainnet": { network: ["testnet", "mainnet"] },
    "legacy mainnet deployment": { network: ["testnet", "mainnet"], deployments: { mainnet: { x: "C" } } },
    "legacy claims reproducible": { reproducible: true },
  };
  for (const [label, patch] of Object.entries(cases)) {
    const lock = clone(REAL);
    lock.contracts.transfer_agent = { ...base, ...patch };
    assert.ok(lintLock(lock).errors.length, label);
  }
});

test("the lock reader refuses a lock that breaks the rules", () => {
  const dir = tmp();
  fs.cpSync(path.join(HERE, "lib"), path.join(dir, "scripts", "lib"), { recursive: true });
  const bad = clone(REAL);
  bad.contracts.custody_registry.features = ["testing"];
  fs.writeFileSync(path.join(dir, "contracts.lock.json"), JSON.stringify(bad));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { wasmHash } from ${JSON.stringify(path.join(dir, "scripts", "lib", "contracts-lock.mjs"))}; wasmHash("custody_registry");`], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused/);
});

test("Cargo.toml [features] parser and crate rules", () => {
  const toml = `[package]\nname = "x"\n[features]\ndefault = ["testing"]\ntestnet = []\nmainnet = []\ntesting = []  # skips USDC\nmulti = [\n  "a",\n  "b",\n]\n[profile.release]\nopt-level = "z"\n`;
  assert.deepEqual(cargoFeatures(toml), { default: ["testing"], testnet: [], mainnet: [], testing: [], multi: ["a", "b"] });
  const ok = { features: ["testnet"], no_default_features: true, network: ["testnet"], rustc: "1.86.0" };
  assert.deepEqual(checkAgainstCrate("token_sale", ok, { cargoToml: toml, toolchainToml: 'channel = "1.86.0"' }), []);
  const errs = (c, tc = null) => checkAgainstCrate("token_sale", { ...ok, ...c }, { cargoToml: toml, toolchainToml: tc });
  assert.match(errs({ no_default_features: false }).join(), /default includes `testing`/);
  assert.match(errs({ features: ["nope"] }).join(), /not declared/);
  assert.match(errs({ network: ["testnet", "mainnet"] }).join(), /one entry per network/);
  assert.match(errs({ features: [] }).join(), /needs feature testnet/);
  assert.match(errs({ features: ["mainnet"] }).join(), /does not match network/);
  assert.match(errs({}, 'channel = "1.99.1"').join(), /rust-toolchain\.toml channel 1\.99\.1 != lock rustc 1\.86\.0/);
});

// --rebuild against a local git repo and fake stellar/rustc on PATH.
function fixture({ toolchain = "1.99.1", stellarVersion = "28.1.0", rustcVersion = "1.99.1" } = {}) {
  const root = tmp();
  const src = path.join(root, "src");
  const crate = path.join(src, "contracts", "custody_registry");
  fs.mkdirSync(crate, { recursive: true });
  fs.writeFileSync(path.join(crate, "Cargo.toml"), `[package]\nname = "custody_registry"\n`);
  fs.writeFileSync(path.join(crate, "rust-toolchain.toml"), `[toolchain]\nchannel = "${toolchain}"\n`);
  fs.mkdirSync(path.join(src, "contracts", "transfer_agent"), { recursive: true });
  fs.writeFileSync(path.join(src, "contracts", "transfer_agent", "Cargo.toml"), `[features]\ndefault = ["testing"]\ntesting = []\n`);
  const g = (...a) => execFileSync("git", ["-C", src, ...a], { stdio: "pipe" }).toString().trim();
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "core.autocrlf", "false");
  g("add", "."); g("commit", "-qm", "one");
  const first = g("rev-parse", "HEAD");
  fs.writeFileSync(path.join(crate, "README"), "two\n");
  g("add", "."); g("commit", "-qm", "two");
  const commit = g("rev-parse", "HEAD");
  // Fake tools: the "wasm" is the build args, so its hash is known in advance.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "stellar"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "stellar ${stellarVersion} (fake)"; exit 0; fi
out=""; prev=""; args=""
for a in "$@"; do [ "$prev" = "--out-dir" ] && out="$a"; [ "$a" = "--out-dir" ] || [ "$prev" = "--out-dir" ] || args="$args $a"; prev="$a"; done
[ -n "$FAKE_DIRTY" ] && echo x > "$PWD/dirty.txt"
printf '%s' "$args" > "$out/$(basename "$PWD").wasm"
`);
  fs.writeFileSync(path.join(bin, "rustc"), `#!/bin/sh\necho "rustc ${rustcVersion} (fake)"\n`);
  fs.chmodSync(path.join(bin, "stellar"), 0o755);
  fs.chmodSync(path.join(bin, "rustc"), 0o755);
  const lock = clone(REAL);
  lock.commit = commit;
  const env = { PATH: `${bin}:${process.env.PATH}`, RADOX_CONTRACTS_REPO: src, RAIL_CONTRACTS_CACHE: path.join(root, "cache"), GIT_CONFIG_GLOBAL: "/dev/null" };
  const expected = sha(" contract build --locked --no-default-features");
  return { root, src, commit, first, lock, env, expected, cache: path.join(root, "cache", commit) };
}

test("--rebuild ok: same sha256, legacy warns, exit 0", () => {
  const f = fixture();
  f.lock.contracts.custody_registry.wasm_sha256 = f.expected;
  const r = run(f.lock, ["--rebuild"], f.env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`ok custody_registry ${f.expected}`));
  assert.match(r.out, /WARN transfer_agent legacy, not rebuilt/);
  assert.deepEqual(r.report.results.map((x) => x.status), ["ok", "legacy"]);
  // A second run reuses the cached checkout, still clean.
  assert.equal(run(f.lock, ["--rebuild"], f.env).code, 0);
});

test("--rebuild refuses a different sha256", () => {
  const f = fixture();
  const r = run(f.lock, ["--rebuild"], f.env); // real hash 8230ed93… never matches the fake wasm
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /XX custody_registry [0-9a-f]{64} != lock 8230ed93/);
});

test("--rebuild refuses a cached checkout at the wrong HEAD", () => {
  const f = fixture();
  f.lock.contracts.custody_registry.wasm_sha256 = f.expected;
  execFileSync("git", ["clone", "-q", f.src, f.cache]);
  execFileSync("git", ["-C", f.cache, "checkout", "-q", "--detach", f.first]);
  const r = run(f.lock, ["--rebuild"], f.env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`HEAD ${f.first} != lock.commit ${f.commit}`));
});

test("--rebuild refuses a dirty cached checkout (modified or untracked)", () => {
  for (const dirt of ["modified", "untracked"]) {
    const f = fixture();
    f.lock.contracts.custody_registry.wasm_sha256 = f.expected;
    assert.equal(run(f.lock, ["--rebuild"], f.env).code, 0);
    const crate = path.join(f.cache, "contracts", "custody_registry");
    if (dirt === "modified") fs.appendFileSync(path.join(crate, "Cargo.toml"), "# x\n");
    else fs.writeFileSync(path.join(crate, "new.rs"), "");
    const r = run(f.lock, ["--rebuild"], f.env);
    assert.equal(r.code, 1, `${dirt}: ${r.out}`);
    assert.match(r.out, /dirty tree/);
  }
});

test("--rebuild refuses a build that writes into the checkout", () => {
  const f = fixture();
  f.lock.contracts.custody_registry.wasm_sha256 = f.expected;
  const r = run(f.lock, ["--rebuild"], { ...f.env, FAKE_DIRTY: "1" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /!! custody_registry .*dirty tree/);
});

test("--rebuild refuses the wrong toolchain (rust-toolchain.toml, rustc, stellar-cli)", () => {
  const cases = [
    [{ toolchain: "1.86.0" }, /rust-toolchain\.toml channel 1\.86\.0 != lock rustc 1\.99\.1/],
    [{ rustcVersion: "1.97.1" }, /rustc 1\.97\.1 != lock 1\.99\.1/],
    [{ stellarVersion: "23.0.0" }, /stellar-cli 23\.0\.0 != lock 28\.1\.0/],
  ];
  for (const [opts, re] of cases) {
    const f = fixture(opts);
    f.lock.contracts.custody_registry.wasm_sha256 = f.expected;
    const r = run(f.lock, ["--rebuild"], f.env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, re);
  }
});

test("--rebuild refuses a commit missing from the source repo", () => {
  const f = fixture();
  f.lock.commit = "0".repeat(40);
  const r = run(f.lock, ["--rebuild"], f.env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /XX checkout: git fetch/);
});

test("--rebuild applies the static rules first (testing never builds)", () => {
  const f = fixture();
  f.lock.contracts.custody_registry.features = ["testing"];
  const r = run(f.lock, ["--rebuild"], f.env);
  assert.equal(r.code, 1);
  assert.ok(!fs.existsSync(f.cache), "no checkout or build for a refused lock");
});
