// Mainnet gate: mainnet-deploy and mainnet-rehearsal rebuild the whole lock and stop before any
// network connection unless it matches. Runs each script in a temp copy of the repo with a local
// contracts repo, fake stellar/rustc, and a preload that blocks (and records) every TCP connect.
// Run: node --test scripts/mainnet-gate.test.mjs (nothing leaves the machine).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const REAL = JSON.parse(fs.readFileSync(path.join(REPO, "contracts.lock.json"), "utf8"));
const REAL_CR = REAL.contracts.custody_registry.wasm_sha256; // what the real build gives (8230ed93…)
const QA = path.join(os.homedir(), ".cache", "qa-radox-f3", "mut");
const PUBLIC = "Public Global Stellar Network ; September 2015";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mgate-"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const fakeWasm = (crate) => `${crate}| contract build --locked --no-default-features`;

// qa r2 mutants, inlined so the test does not depend on ~/.cache (same edits as the qa files).
const MUTANTS = {
  // transfer_agent flipped to non-legacy, reproducible, on mainnet, keeping the installed hash.
  r2_ta_flip_main: (l) => {
    const t = l.contracts.transfer_agent;
    Object.assign(t, { features: [], legacy: false, network: ["testnet", "mainnet"], no_default_features: true, reproducible: true });
    delete t.$note;
  },
  // custody_registry given the legacy transfer_agent hash.
  r2_cr_legacyhash: (l) => { l.contracts.custody_registry.wasm_sha256 = "3870748b709f7b8531c7ebbbc975712333f61949831350ff7192f7076fc6bff1"; },
};

function fixture() {
  const root = tmp();
  const src = path.join(root, "src");
  const crates = { custody_registry: { rustc: "1.99.1", features: "" }, transfer_agent: { rustc: "1.86.0", features: '[features]\ndefault = ["testing"]\ntesting = []\n' } };
  for (const [name, c] of Object.entries(crates)) {
    const d = path.join(src, "contracts", name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "Cargo.toml"), `[package]\nname = "${name}"\n${c.features}`);
    fs.writeFileSync(path.join(d, "rust-toolchain.toml"), `[toolchain]\nchannel = "${c.rustc}"\n`);
  }
  const g = (...a) => execFileSync("git", ["-C", src, ...a], { stdio: "pipe" }).toString().trim();
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "core.autocrlf", "false");
  g("add", "."); g("commit", "-qm", "src");
  const commit = g("rev-parse", "HEAD");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "stellar"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "stellar 28.1.0 (fake)"; exit 0; fi
out=""; prev=""; args=""
for a in "$@"; do [ "$prev" = "--out-dir" ] && out="$a"; [ "$a" = "--out-dir" ] || [ "$prev" = "--out-dir" ] || args="$args $a"; prev="$a"; done
pol=""
for v in RUSTFLAGS CARGO_ENCODED_RUSTFLAGS RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER CARGO_BUILD_RUSTFLAGS CARGO_PROFILE_RELEASE_OPT_LEVEL CARGO_TARGET_WASM32V1_NONE_RUSTFLAGS; do eval "x=\\\${$v:-}"; [ -n "$x" ] && pol="$pol|$v=$x"; done
d="$PWD"; while :; do for c in "$d/.cargo/config" "$d/.cargo/config.toml"; do [ -f "$c" ] && pol="$pol|cfg:$(cat "$c")"; done; [ "$d" = "/" ] && break; d=$(dirname "$d"); done
ch="\${CARGO_HOME:-$HOME/.cargo}"; for c in "$ch/config" "$ch/config.toml"; do [ -f "$c" ] && pol="$pol|home:$(cat "$c")"; done
printf '%s|%s%s' "$(basename "$PWD")" "$args" "$pol" > "$out/$(basename "$PWD").wasm"
`);
  fs.writeFileSync(path.join(bin, "rustc"), `#!/bin/sh\necho "rustc $RUSTUP_TOOLCHAIN (fake)"\n`);
  fs.chmodSync(path.join(bin, "stellar"), 0o755);
  fs.chmodSync(path.join(bin, "rustc"), 0o755);
  // Preload: any TCP connect from the script is recorded and refused.
  const marker = path.join(root, "connects.log");
  const preload = path.join(root, "no-net.mjs");
  fs.writeFileSync(preload, `import net from "node:net"; import fs from "node:fs";
const orig = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(a[0]?.host ?? a[0]?.path ?? a[1] ?? a[0]) + "\\n"); this.destroy(new Error("blocked by test: no network")); return this; };
globalThis.fetch = async (u) => { fs.appendFileSync(${JSON.stringify(marker)}, String(u) + "\\n"); throw new Error("blocked by test: no network"); };
`);
  return { root, src, commit, bin, marker, preload, cache: path.join(root, "cache") };
}

// Temp copy of the repo with `lock` (real hashes mapped to the fake builder's output).
function runScript(f, script, lock, env, args = []) {
  const dir = fs.mkdtempSync(path.join(f.root, "repo-"));
  fs.cpSync(path.join(REPO, "scripts"), path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(dir, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const l = JSON.parse(JSON.stringify(lock));
  l.commit = f.commit;
  if (l.contracts.custody_registry.wasm_sha256 === REAL_CR) l.contracts.custody_registry.wasm_sha256 = sha(fakeWasm("custody_registry"));
  fs.writeFileSync(path.join(dir, "contracts.lock.json"), JSON.stringify(l, null, 2));
  fs.rmSync(f.marker, { force: true });
  const r = spawnSync(process.execPath, ["--import", f.preload, path.join(dir, "scripts", script), ...args], {
    encoding: "utf8", cwd: dir, timeout: 60_000,
    env: {
      PATH: `${f.bin}:${process.env.PATH}`, HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null",
      RADOX_CONTRACTS_REPO: f.src, RAIL_CONTRACTS_CACHE: f.cache, NETWORK_PASSPHRASE: PUBLIC, ...env,
    },
  });
  const connects = fs.existsSync(f.marker) ? fs.readFileSync(f.marker, "utf8").trim().split("\n") : [];
  return { code: r.status, out: r.stdout + r.stderr, connects };
}

const DEPLOY_ENV = { RPC_URL: "https://mainnet.sorobanrpc.com" };
const REHEARSAL_ENV = { RPC_URL: "http://127.0.0.1:9" };

test("qa mutants inlined here match the qa files (when present)", (t) => {
  for (const name of Object.keys(MUTANTS)) {
    const file = path.join(QA, `${name}.json`);
    if (!fs.existsSync(file)) { t.diagnostic(`${file} not here; inlined copy used`); continue; }
    const l = JSON.parse(JSON.stringify(REAL));
    MUTANTS[name](l);
    assert.deepEqual(l, JSON.parse(fs.readFileSync(file, "utf8")), name);
  }
});

for (const [script, env] of [["mainnet-deploy.mjs", DEPLOY_ENV], ["mainnet-rehearsal.mjs", REHEARSAL_ENV]]) {
  for (const [name, mutate] of Object.entries(MUTANTS)) {
    test(`${script} refuses ${name} before any connection, even with CONFIRM_MAINNET=send`, () => {
      const f = fixture();
      const lock = JSON.parse(JSON.stringify(REAL));
      mutate(lock);
      for (const extra of [{}, { CONFIRM_MAINNET: "send", ADMIN_LEDGER: "GXXX" }]) {
        const r = runScript(f, script, lock, { ...env, ...extra });
        assert.notEqual(r.code, 0, r.out);
        assert.match(r.out, /rebuild from [0-9a-f]{40} does not match the lock .*nothing sent/);
        assert.deepEqual(r.connects, [], `connected before the gate: ${r.connects}`);
        assert.doesNotMatch(r.out, /approve on the Ledger|CONFIRM_MAINNET/);
      }
    });
  }
  test(`${script} with a good lock passes the gate and stops at the next guard`, () => {
    const f = fixture();
    if (script === "mainnet-deploy.mjs") {
      // Without CONFIRM_MAINNET: stops at that guard, still with no connection.
      const r = runScript(f, script, REAL, env);
      assert.notEqual(r.code, 0);
      assert.match(r.out, /real mainnet: set CONFIRM_MAINNET=send/, r.out);
      assert.match(r.out, /rebuilding .* before using custody_registry/);
      assert.deepEqual(r.connects, []);
      // With it: the first thing after the gate is the RPC read (blocked here), never a Ledger prompt.
      const r2 = runScript(f, script, REAL, { ...env, CONFIRM_MAINNET: "send", ADMIN_LEDGER: "GXXX" });
      assert.notEqual(r2.code, 0);
      assert.ok(r2.connects.length > 0, r2.out);
      assert.doesNotMatch(r2.out, /approve on the Ledger/);
    } else {
      const r = runScript(f, script, REAL, env);
      assert.notEqual(r.code, 0);
      assert.match(r.out, /rebuilding .* before using custody_registry/);
      assert.deepEqual(r.connects, ["http://127.0.0.1:9"], r.out); // fork_info, the step after the gate
    }
  });
}

// qa r3 #1: the gate never builds from the cache, so a replace-tampered cache cannot reach mainnet.
test("mainnet gate ignores a replace-tampered RAIL_CONTRACTS_CACHE (fresh fetch every time)", () => {
  const f = fixture();
  const c = path.join(f.cache, f.commit);
  const g = (...a) => execFileSync("git", ["-C", c, ...a], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  execFileSync("git", ["clone", "-q", f.src, c], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  // Tamper like the qa: replace the custody crate's Cargo.toml blob (HEAD stays at the commit).
  const blob = g("rev-parse", "HEAD:contracts/custody_registry/Cargo.toml");
  fs.writeFileSync(path.join(f.root, "evil.toml"), `[package]\nname = "evil"\n`);
  g("replace", blob, g("hash-object", "-w", path.join(f.root, "evil.toml")));
  g("read-tree", "HEAD"); g("checkout", "-f", "HEAD", "--", ".");
  assert.match(fs.readFileSync(path.join(c, "contracts", "custody_registry", "Cargo.toml"), "utf8"), /evil/);
  const before = fs.readdirSync(f.cache).sort();
  const r = runScript(f, "mainnet-deploy.mjs", REAL, DEPLOY_ENV);
  assert.match(r.out, /custody_registry rebuilt from [0-9a-f]{40} = /, r.out);
  assert.match(r.out, /real mainnet: set CONFIRM_MAINNET=send/);
  assert.deepEqual(r.connects, []);
  assert.deepEqual(fs.readdirSync(f.cache).sort(), before, "the gate wrote into the cache");
  // The same replace in the source repo is not followed either (GIT_NO_REPLACE_OBJECTS, fresh fetch by sha).
  const s = (...a) => execFileSync("git", ["-C", f.src, ...a], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  s("replace", blob, s("hash-object", "-w", path.join(f.root, "evil.toml")));
  const r2 = runScript(f, "mainnet-deploy.mjs", REAL, DEPLOY_ENV);
  assert.match(r2.out, /real mainnet: set CONFIRM_MAINNET=send/, r2.out);
});

// qa r3 #2: every script that imports lib/stellar.mjs, except the two gated mainnet scripts,
// refuses a mainnet environment before any connection (REGISTRY_WASM_HASH included).
const MAINNET_SCRIPTS = ["mainnet-deploy.mjs", "mainnet-rehearsal.mjs"];
const STELLAR_USERS = fs.readdirSync(HERE).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs"))
  .filter((n) => /from "\.\/lib\/stellar\.mjs"/.test(fs.readFileSync(path.join(HERE, n), "utf8")));

test("the stellar.mjs importers are the known five", () => {
  assert.deepEqual(STELLAR_USERS.sort(), ["lifecycle.mjs", "mainnet-deploy.mjs", "mainnet-rehearsal.mjs", "multi-chain.mjs", "remote-auth.mjs"]);
});

for (const script of STELLAR_USERS.filter((n) => !MAINNET_SCRIPTS.includes(n))) {
  test(`${script} refuses a mainnet environment before any connection`, () => {
    const f = fixture();
    const argsets = script === "remote-auth.mjs" ? [[], ["prepare"], ["sign"], ["submit"]] : [[]];
    for (const rpcUrl of ["https://mainnet.sorobanrpc.com", "https://soroban-testnet.stellar.org"]) {
      for (const args of argsets) {
        const r = runScript(f, script, REAL, {
          RPC_URL: rpcUrl, HORIZON_URL: "https://horizon.stellar.org",
          REGISTRY_WASM_HASH: "ab".repeat(32), CONFIRM_MAINNET: "send", SIGNER_SECRET: "SXXX",
        }, args);
        assert.equal(r.code, 1, `${script} ${args}: ${r.out}`);
        assert.match(r.out, /testnet only: NETWORK_PASSPHRASE must be the testnet passphrase/);
        assert.deepEqual(r.connects, [], `${script} ${args} connected: ${r.connects}`);
      }
    }
  });
}

// qa r4: the cargo build environment. The fake builder, like cargo, folds inherited flags and any
// .cargo/config(.toml) above the crate or in CARGO_HOME into the bytes. Each lock below claims the
// hash of such a polluted build; the gate must never produce it.
const CLEAN = fakeWasm("custody_registry");
const POLLUTED = {
  "RUSTFLAGS inherited": { env: { RUSTFLAGS: "-C opt-level=0" }, tail: "|RUSTFLAGS=-C opt-level=0" },
  "RUSTC_WRAPPER inherited": { env: { RUSTC_WRAPPER: "/usr/bin/evil" }, tail: "|RUSTC_WRAPPER=/usr/bin/evil" },
  "CARGO_ENCODED_RUSTFLAGS inherited": { env: { CARGO_ENCODED_RUSTFLAGS: "-Cdebuginfo=2" }, tail: "|CARGO_ENCODED_RUSTFLAGS=-Cdebuginfo=2" },
  "CARGO_PROFILE_* inherited": { env: { CARGO_PROFILE_RELEASE_OPT_LEVEL: "1" }, tail: "|CARGO_PROFILE_RELEASE_OPT_LEVEL=1" },
  "CARGO_TARGET_* inherited": { env: { CARGO_TARGET_WASM32V1_NONE_RUSTFLAGS: "-Cx" }, tail: "|CARGO_TARGET_WASM32V1_NONE_RUSTFLAGS=-Cx" },
  "TMPDIR with .cargo/config.toml in its parent": {
    setup: (f) => { const t = path.join(f.root, "shared"); fs.mkdirSync(path.join(t, ".cargo"), { recursive: true }); fs.writeFileSync(path.join(t, ".cargo", "config.toml"), "evil"); fs.mkdirSync(path.join(t, "tmp")); return { TMPDIR: path.join(t, "tmp") }; },
    tail: "|cfg:evil",
  },
};
for (const [label, p] of Object.entries(POLLUTED)) {
  test(`mainnet gate: ${label} never changes the build`, () => {
    const f = fixture();
    const env = { ...DEPLOY_ENV, ...(p.env ?? {}), ...(p.setup ? p.setup(f) : {}) };
    const forged = JSON.parse(JSON.stringify(REAL));
    forged.contracts.custody_registry.wasm_sha256 = sha(CLEAN + p.tail);
    const r = runScript(f, "mainnet-deploy.mjs", forged, env);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /does not match the lock .*nothing sent/, `${label}: forged hash accepted\n${r.out}`);
    assert.deepEqual(r.connects, []);
    // The clean hash still passes with the same environment: the flags were dropped, not obeyed.
    const ok = runScript(f, "mainnet-deploy.mjs", REAL, env);
    assert.match(ok.out, /real mainnet: set CONFIRM_MAINNET=send/, `${label}:\n${ok.out}`);
  });
}

for (const [label, setup] of Object.entries({
  "config in CARGO_HOME": (f) => { const h = path.join(f.root, "ch"); fs.mkdirSync(h); fs.writeFileSync(path.join(h, "config.toml"), "evil"); return { CARGO_HOME: h }; },
  "config in the default CARGO_HOME (~/.cargo)": (f) => { fs.mkdirSync(path.join(f.root, ".cargo")); fs.writeFileSync(path.join(f.root, ".cargo", "config"), "evil"); return {}; },
  "config in an ancestor of the gate dir": (f) => { fs.mkdirSync(path.join(f.root, ".cache", ".cargo"), { recursive: true }); fs.writeFileSync(path.join(f.root, ".cache", ".cargo", "config.toml"), "evil"); return {}; },
})) {
  test(`mainnet gate refuses ${label}, forged or clean lock`, () => {
    const f = fixture();
    const env = { ...DEPLOY_ENV, ...setup(f) };
    const forged = JSON.parse(JSON.stringify(REAL));
    forged.contracts.custody_registry.wasm_sha256 = sha(CLEAN + (label.includes("ancestor") ? "|cfg:evil" : "|home:evil"));
    for (const lock of [forged, REAL]) {
      const r = runScript(f, "mainnet-deploy.mjs", lock, env);
      assert.notEqual(r.code, 0);
      assert.match(r.out, /cargo config outside the pinned source/, `${label}:\n${r.out}`);
      assert.deepEqual(r.connects, []);
    }
  });
}

test("mainnet gate builds under ~/.cache/radox-rail-gate (0700), never TMPDIR", () => {
  const f = fixture();
  const gate = path.join(f.root, ".cache", "radox-rail-gate");
  fs.mkdirSync(gate, { recursive: true, mode: 0o777 });
  fs.chmodSync(gate, 0o777);
  const r = runScript(f, "mainnet-deploy.mjs", REAL, { ...DEPLOY_ENV, TMPDIR: path.join(f.root, "nope") });
  assert.match(r.out, /real mainnet: set CONFIRM_MAINNET=send/, r.out);
  assert.equal(fs.statSync(gate).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(gate), [], "run dir left behind");
  // A symlinked gate dir is refused.
  const g2 = fixture();
  fs.mkdirSync(path.join(g2.root, ".cache"), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(g2.root, ".cache", "radox-rail-gate"));
  const r2 = runScript(g2, "mainnet-deploy.mjs", REAL, DEPLOY_ENV);
  assert.match(r2.out, /must be a directory owned by you with mode 0700/, r2.out);
});
