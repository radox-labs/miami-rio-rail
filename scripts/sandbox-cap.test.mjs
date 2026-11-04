// checkCap against a stubbed Horizon: only transactions the sandbox account sent count toward the
// hourly cap. Run: node scripts/sandbox-cap.test.mjs (no network, no keys).
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { checkCap, OPENS_PER_HOUR } from "../page/api/_lib/rail.js";

const op = Keypair.random(), stranger = Keypair.random().publicKey();
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const tx = (source, min) => ({ source_account: source, created_at: ago(min) });

// Horizon's account transactions, newest first, served in pages with a cursor
function stub(records, xlm = "9000") {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (!u.pathname.endsWith("/transactions")) return { ok: true, json: async () => ({ balances: [{ asset_type: "native", balance: xlm }] }) };
    const limit = Number(u.searchParams.get("limit")), from = Number(u.searchParams.get("cursor") ?? 0);
    const page = records.slice(from, from + limit);
    return { ok: true, json: async () => ({ _embedded: { records: page.map((r, i) => ({ ...r, paging_token: String(from + i + 1) })) } }) };
  };
}
const cap = async () => checkCap(op).then(() => "open", (e) => e.code);

// 1. a stranger sends one-stroop payments to the sandbox account: opens must stay open
stub(Array.from({ length: 300 }, (_, i) => tx(stranger, i / 10)));
assert.equal(await cap(), "open", "incoming payments from a stranger must not count toward the cap");

// 2. the operator's own opens (two transactions each) still hit the cap
stub(Array.from({ length: OPENS_PER_HOUR * 2 }, (_, i) => tx(op.publicKey(), i)));
assert.equal(await cap(), "E_SANDBOX_CAP");

// 3. spam in front of the operator's own transactions does not hide them
stub([...Array.from({ length: 250 }, (_, i) => tx(stranger, i / 100)), ...Array.from({ length: OPENS_PER_HOUR * 2 }, (_, i) => tx(op.publicKey(), 5 + i))]);
assert.equal(await cap(), "E_SANDBOX_CAP", "own transactions behind a page of spam still count");

// 4. own transactions older than an hour do not count
stub(Array.from({ length: OPENS_PER_HOUR * 2 }, (_, i) => tx(op.publicKey(), 61 + i)));
assert.equal(await cap(), "open");

// 5. the balance floor still holds
stub([], "100");
assert.equal(await cap(), "E_SANDBOX_EMPTY");

console.log("sandbox cap: 5 checks passed");
