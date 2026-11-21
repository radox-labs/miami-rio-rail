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
import { cargoFeatures, checkAgainstCrate, featureClosure, lintLock } from "./lib/lock-rules.mjs";

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
  // qa r1 A1: `default` turns the crate defaults (`testing`) back on, alone or with a network feature.
  "explicit default": (c) => { c.features = ["default"]; c.no_default_features = true; },
  "default + network feature": (c) => { c.features = ["default", "testnet"]; c.network = ["testnet"]; },
  "Testing (case)": (c) => { c.features = ["Testing"]; },
  "testutils": (c) => { c.features = ["testutils"]; },
  "dependency testutils": (c) => { c.features = ["soroban-sdk/testutils"]; },
  "feature outside the allowlist": (c) => { c.features = ["extra"]; },
  "network feature on two networks": (c) => { c.features = ["testnet"]; c.network = ["testnet", "mainnet"]; },
  "network feature for the other network": (c) => { c.features = ["mainnet"]; c.network = ["testnet"]; c.deployments = { testnet: {} }; },
  // qa r1 A2: path must stay a crate dir of the checkout.
  "path with ..": (c) => { c.path = "../evil/contracts/custody_registry"; },
  "path absolute": (c) => { c.path = "/tmp/evil/contracts/custody_registry"; },
  "path nested": (c) => { c.path = "contracts/custody_registry/../../evil"; },
  // qa r1 A3: only transfer_agent may be legacy.
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

// The lock reader used by lifecycle, mainnet-deploy etc., against a given lock.
function reader(lock, call) {
  const dir = tmp();
  fs.cpSync(path.join(HERE, "lib"), path.join(dir, "scripts", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "contracts.lock.json"), JSON.stringify(lock));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { wasmHash } from ${JSON.stringify(path.join(dir, "scripts", "lib", "contracts-lock.mjs"))}; console.log(${call});`], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}
const TESTNET = '{ network: "testnet" }';
const MAINNET = '{ network: "mainnet" }';

test("the lock reader refuses every mutated lock (same rules as the CLI)", () => {
  for (const name of Object.keys(REAL.contracts)) {
    for (const [label, mutate] of Object.entries(MUTATIONS)) {
      const lock = clone(REAL);
      mutate(lock.contracts[name]);
      const r = reader(lock, `wasmHash("custody_registry", ${TESTNET})`);
      assert.notEqual(r.code, 0, `${label} on ${name}: reader handed out ${r.out}`);
      assert.match(r.err, /refused/);
    }
  }
});

test("wasmHash needs a network; mainnet only from a reproducible non-legacy entry", () => {
  assert.equal(reader(REAL, `wasmHash("custody_registry", ${TESTNET})`).out, REAL.contracts.custody_registry.wasm_sha256);
  assert.equal(reader(REAL, `wasmHash("custody_registry", ${MAINNET})`).out, REAL.contracts.custody_registry.wasm_sha256);
  assert.equal(reader(REAL, `wasmHash("transfer_agent", ${TESTNET})`).out, REAL.contracts.transfer_agent.wasm_sha256);
  for (const call of [`wasmHash("custody_registry")`, `wasmHash("custody_registry", {})`, `wasmHash("custody_registry", { network: "futurenet" })`]) {
    const r = reader(REAL, call);
    assert.notEqual(r.code, 0, call);
    assert.match(r.err, /pass \{ network/);
  }
  const r = reader(REAL, `wasmHash("transfer_agent", ${MAINNET})`);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not built for mainnet/);
  // A non-legacy testnet-only variant cannot be used on mainnet either.
  const tn = clone(REAL);
  tn.contracts.custody_registry.network = ["testnet"];
  delete tn.contracts.custody_registry.deployments.mainnet;
  assert.match(reader(tn, `wasmHash("custody_registry", ${MAINNET})`).err, /not built for mainnet/);
});

test("custody_registry cannot be demoted to legacy (qa cr_legacy), in every mode", () => {
  for (const keepMainnet of [true, false]) {
    const lock = clone(REAL);
    const c = lock.contracts.custody_registry;
    Object.assign(c, { legacy: true, reproducible: false, features: null, no_default_features: null, network: ["testnet"], wasm_sha256: "ab".repeat(32) });
    if (!keepMainnet) c.deployments = {};
    else delete c.deployments.mainnet;
    assert.match(lintLock(lock).errors.join(), /only transfer_agent may be legacy/);
    for (const args of [["--static"], ["--rebuild"], []]) assert.equal(run(lock, args).code, 1, args.join());
    assert.notEqual(reader(lock, `wasmHash("custody_registry", ${TESTNET})`).code, 0);
    assert.notEqual(reader(lock, `wasmHash("custody_registry", ${MAINNET})`).code, 0);
  }
});

test("token_sale: `default` with a network feature is refused; the network feature alone passes", () => {
  const ts = {
    path: "contracts/token_sale", rustc: "1.86.0", stellar_cli: "28.1.0", soroban_sdk: "25.3.0",
    network: ["testnet"], features: ["testnet"], no_default_features: true,
    wasm_sha256: "cd".repeat(32), legacy: false, reproducible: true, deployments: {},
  };
  const ok = clone(REAL);
  ok.contracts.token_sale = ts;
  assert.deepEqual(lintLock(ok).errors, []);
  for (const features of [["default", "testnet"], ["default"], ["testnet", "testing"], ["mainnet"]]) {
    const lock = clone(ok);
    lock.contracts.token_sale.features = features;
    for (const args of [["--static"], ["--rebuild"]]) assert.equal(run(lock, args).code, 1, `${features} ${args}`);
    assert.notEqual(reader(lock, `wasmHash("token_sale", ${TESTNET})`).code, 0, String(features));
  }
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
  // Transitive: a network feature that switches on testing (directly, via another feature, or a dep) is refused.
  for (const testnet of ['["testing"]', '["helper"]', '["soroban-sdk/testutils"]', '["dep:x", "x/Testing"]']) {
    const t = `[features]\ndefault = []\ntestnet = ${testnet}\nhelper = ["testing"]\ntesting = []\n`;
    assert.match(checkAgainstCrate("token_sale", ok, { cargoToml: t, toolchainToml: null }).join(), /turn on/, testnet);
  }
  assert.deepEqual(featureClosure({ a: ["b"], b: ["c", "a"], c: [] }, ["a"]), ["a", "b", "c"]);
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
  // A committed symlink that points out of the checkout (qa r1 A2).
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "Cargo.toml"), `[package]\nname = "linked"\n`);
  fs.writeFileSync(path.join(outside, "rust-toolchain.toml"), `[toolchain]\nchannel = "${toolchain}"\n`);
  fs.symlinkSync(outside, path.join(src, "contracts", "linked"));
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
# FAKE_NOWRITE: like cargo with a fresh fingerprint, reuse whatever the target dir already holds.
if [ -n "$FAKE_NOWRITE" ]; then f="$CARGO_TARGET_DIR/wasm32v1-none/release/$(basename "$PWD").wasm"; [ -f "$f" ] && cp "$f" "$out/"; exit 0; fi
printf '%s' "$args" > "$out/$(basename "$PWD").wasm"
[ -n "$FAKE_OLD" ] && touch -d 2000-01-01 "$out/$(basename "$PWD").wasm"
exit 0
`);
  fs.writeFileSync(path.join(bin, "rustc"), `#!/bin/sh\necho "rustc ${rustcVersion} (fake)"\n`);
  fs.chmodSync(path.join(bin, "stellar"), 0o755);
  fs.chmodSync(path.join(bin, "rustc"), 0o755);
  // Own lock: a future bump or the legacy swap (decision G) must not change these tests.
  const lock = {
    repo: "test/radox-contracts", commit,
    contracts: {
      custody_registry: {
        path: "contracts/custody_registry", rustc: "1.99.1", stellar_cli: "28.1.0",
        network: ["testnet", "mainnet"], features: [], no_default_features: true,
        wasm_sha256: "a".repeat(64), legacy: false, reproducible: true,
        deployments: { testnet: { demo: "C1" }, mainnet: { proof: "C2" } },
      },
      transfer_agent: {
        path: "contracts/transfer_agent", rustc: "1.86.0", stellar_cli: "28.1.0",
        network: ["testnet"], features: null, no_default_features: null,
        wasm_sha256: "b".repeat(64), legacy: true, reproducible: false,
        deployments: { testnet: { lifecycle_instance: "C3" } },
      },
    },
  };
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
  const r = run(f.lock, ["--rebuild"], f.env); // "aaaa…" never matches the fake wasm
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`XX custody_registry ${f.expected} != lock a{64}`));
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

test("--rebuild refuses a crate path that resolves outside the checkout (symlink)", () => {
  const f = fixture();
  f.lock.contracts.custody_registry.path = "contracts/linked";
  f.lock.contracts.custody_registry.wasm_sha256 = f.expected;
  const r = run(f.lock, ["--rebuild"], f.env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /outside the checkout/);
});

test("--rebuild never measures a wasm left by an earlier build (poisoned target/out)", () => {
  const f = fixture();
  f.lock.contracts.custody_registry.wasm_sha256 = f.expected;
  assert.equal(run(f.lock, ["--rebuild"], f.env).code, 0);
  // Plant the expected wasm wherever an earlier run could have left it, then build nothing.
  const cacheRoot = f.env.RAIL_CONTRACTS_CACHE;
  for (const d of [path.join(cacheRoot, "out", f.commit, "custody_registry-nodefault"), path.join(cacheRoot, "target", f.commit, "custody_registry-nodefault", "wasm32v1-none", "release"), path.join(cacheRoot, "runs")]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "custody_registry.wasm"), " contract build --locked --no-default-features");
  }
  const r = run(f.lock, ["--rebuild"], { ...f.env, FAKE_NOWRITE: "1" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /build produced no/);
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, "runs")).filter((x) => x.endsWith(".wasm")), ["custody_registry.wasm"]);
});

test("--rebuild refuses a wasm older than the build", () => {
  const f = fixture();
  f.lock.contracts.custody_registry.wasm_sha256 = f.expected;
  const r = run(f.lock, ["--rebuild"], { ...f.env, FAKE_OLD: "1" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /older than this build/);
});
