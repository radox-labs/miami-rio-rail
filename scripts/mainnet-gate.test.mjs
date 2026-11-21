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
printf '%s|%s' "$(basename "$PWD")" "$args" > "$out/$(basename "$PWD").wasm"
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
function runScript(f, script, lock, env) {
  const dir = fs.mkdtempSync(path.join(f.root, "repo-"));
  fs.cpSync(path.join(REPO, "scripts"), path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(dir, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const l = JSON.parse(JSON.stringify(lock));
  l.commit = f.commit;
  if (l.contracts.custody_registry.wasm_sha256 === REAL_CR) l.contracts.custody_registry.wasm_sha256 = sha(fakeWasm("custody_registry"));
  fs.writeFileSync(path.join(dir, "contracts.lock.json"), JSON.stringify(l, null, 2));
  fs.rmSync(f.marker, { force: true });
  const r = spawnSync(process.execPath, ["--import", f.preload, path.join(dir, "scripts", script)], {
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
