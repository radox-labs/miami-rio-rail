// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// Shared testnet helpers: fund, send classic ops, invoke with per-signer auth entries.
import {
  Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, scValToNative,
  authorizeEntry, rpc,
} from "@stellar/stellar-sdk";

export const NET = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
export const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
export const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
export const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://127.0.0.1") });

export const addr = (g) => nativeToScVal(g, { type: "address" });
export const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

export async function fund(kp) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status} for ${kp.publicKey()}`);
}

export async function waitFor(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await server.getTransaction(hash);
    if (r.status !== "NOT_FOUND") return r;
    await sleep(2000);
  }
  throw new Error(`tx ${hash} not found after 120 s`);
}

// classic ops signed by `source` (and any extra signers)
export async function sendClassic(source, ops, extra = []) {
  const acct = await server.getAccount(source.publicKey());
  const b = new TransactionBuilder(acct, { fee: "10000", networkPassphrase: NET }).setTimeout(120);
  ops.forEach((o) => b.addOperation(o));
  const tx = await signWith(b.build(), source);
  tx.sign(...extra);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
  const r = await waitFor(sent.hash);
  if (r.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${r.status}`);
  return sent.hash;
}

// a source is a Keypair, or { publicKey(), signTx(tx) } for a signer outside this process (a Ledger)
async function signWith(tx, source) {
  if (source.signTx) return source.signTx(tx);
  tx.sign(source);
  return tx;
}

const credOf = (e) => e.credentials.addressV2 ?? e.credentials.address; // protocol 29 returns AddressV2

// Simulate, have each required address sign its own auth entry, re-simulate, send.
// keys: { G...: Keypair }. Returns { hash, status, auth, result } or { simError, auth }.
export async function invokeOp(op, source, keys, { send = true } = {}) {
  const txWith = async (o) => new TransactionBuilder(await server.getAccount(source.publicKey()),
    { fee: "5000000", networkPassphrase: NET }).addOperation(o).setTimeout(120).build();
  const sim = await server.simulateTransaction(await txWith(op()));
  if (rpc.Api.isSimulationError(sim)) return { simError: sim.error.split("\n")[0], auth: [] };
  const entries = sim.result.auth;
  const auth = entries.map((e) => e.credentials.type === "sorobanCredentialsSourceAccount"
    ? source.publicKey() : Address.fromScAddress(credOf(e).address).toString());
  if (!send) return { auth, result: sim.result.retval ? scValToNative(sim.result.retval) : undefined };
  const until = (await server.getLatestLedger()).sequence + 100;
  const signed = await Promise.all(entries.map((e, i) => {
    if (e.credentials.type === "sorobanCredentialsSourceAccount") return e;
    const kp = keys[auth[i]];
    if (!kp) throw new Error(`no key for required signer ${auth[i]}`);
    return authorizeEntry(e, kp, until, NET);
  }));
  let tx = await txWith(op(signed));
  const sim2 = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim2)) return { simError: sim2.error.split("\n")[0], auth };
  tx = await signWith(rpc.assembleTransaction(tx, sim2).build(), source);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
  const r = await waitFor(sent.hash);
  const result = r.returnValue ? scValToNative(r.returnValue) : undefined;
  return { hash: sent.hash, status: r.status, auth, result };
}

export const call = (contract, fn, args) => (auth) =>
  Operation.invokeContractFunction({ contract, function: fn, args, auth });

// read-only call through simulation
export async function read(contract, fn, args, source) {
  const r = await invokeOp(call(contract, fn, args), source, {}, { send: false });
  if (r.simError) throw new Error(`${fn}: ${r.simError}`);
  return r.result;
}

export const random = () => Keypair.random();
