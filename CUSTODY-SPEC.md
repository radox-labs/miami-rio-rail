# Custody record: a proposed open spec (v0.1)

Status: **proposed open spec**, draft v0.1, 2026-10-25. It describes the custody record kept by `custody_registry`. Reference implementation: [`radox-labs/radox-contracts`](https://github.com/radox-labs/radox-contracts/tree/main/contracts/custody_registry), running on Stellar testnet. The custody contract is Apache-2.0 licensed.

Our goal is a shared custody format that companies along a supply chain could use, from origin to destination. This document is the first step towards that: it writes down the record format, so that someone other than us can check the record, implement it or argue about it.

## 1. What the record is for

A tokenized shipment has two separate facts: **who owns it** (the token holder) and **who physically holds it** (the custodian). The token answers the first. This record answers the second. Each change of custodian is authorised by both custodians in one transaction. Every step is chained into one 32-byte `head`, so anyone with public chain data can recompute the full history and check it.

The record moves no money and no token. It is not a bill of lading or a document of title, and it does not replace either. On chain, nothing stops a paper bill or a second token from being issued for the same cargo.

## 2. Roles

| Role | Who | Does |
|---|---|---|
| Admin | set at deploy | freezes and unfreezes a shipment, pauses and resumes, allow-lists event sources, sets the pauser |
| Operator | set at deploy | opens shipments |
| Custodian | each address on the route | authorises its handovers, both as giver and as receiver |
| Holder | address named at delivery | co-authorises delivery with the final custodian; the contract does not check that it holds the token |
| Event source | allow-listed by the admin | adds attestations (for example a gate scan) without moving custody |
| Pauser (optional) | set by the admin | can stop writes in an emergency; only the admin resumes |

## 3. The record

| Field | Type | Meaning |
|---|---|---|
| `key` | 32 bytes | shipment id. Recommended: `sha256(utf8(container + "\|" + origin))`, for example `sha256("TEST6109555\|BRRIO")`. The contract accepts any 32 bytes |
| `token` | address | the asset contract that represents the cargo (for example a Stellar Asset Contract) |
| `route` | list of addresses | custodians in order, fixed at open; at least 2; two equal neighbours are refused |
| `current_custodian` | address | `route[seq]` |
| `seq` | u32 | handovers done so far |
| `head` | 32 bytes | hash chain over every step (section 6) |
| `status` | `Open`, `Delivered`, `Frozen` | section 4 |
| `holder` | address or none | set at delivery |

## 4. State machine

```
            handover (seq+1, both custodians)      attest (any status)
              ┌──────┐                              ┌──────┐
              ▼      │                              ▼      │
 open ──▶  [ Open ] ─┘── deliver (seq = last) ──▶ [ Delivered ]
              ▲  │
     unfreeze │  │ freeze (admin)
              │  ▼
           [ Frozen ]
```

- `open(key, token, route, docs_root)`: operator only. Creates the record at `seq = 0`, with `route[0]` as the custodian. A second `open` with the same key is refused.
- `handover(key, from, to, evidence_hash, assurance)`: `from` and `to` must both authorise. `from` must be the current custodian and `to` must be `route[seq+1]`. `assurance` must be 1, 2 or 3. Status must be `Open`.
- `attest(key, source, kind, event_hash)`: the source authorises and must be on the allow-list. Allowed in any status. It does not change `seq` or the custodian.
- `deliver(key, final_custodian, holder)`: both authorise. Every handover must be done (`seq` equals the last route index), and `final_custodian` must be the last stop; otherwise 10 NotFinal. Status becomes `Delivered`.
- `freeze` and `unfreeze`: admin only. They are the exit for lost or seized cargo, a court order or a sanction. Both still work while the contract is paused.
- When the contract is paused, `open`, `handover`, `attest`, `deliver` and the source allow-list calls are refused.

Status checks: `handover`, `deliver` and `freeze` need status `Open`. A `Frozen` shipment is refused with 7 Frozen, and a `Delivered` one with 3 NotOpen. `unfreeze` needs `Frozen`; otherwise 11 NotFrozen.

Check order, which decides the error code when more than one check fails: pause (6); then input validity (`assurance`, 13); then authorisation, where a missing signature aborts the call with no error code; then lookup (8 NotFound); then status; then custodian and route (1, 2, 10). `open` checks DuplicateKey (4) before BadRoute (9). `attest` checks the allow-list (5) before the lookup.

Error codes: 1 WrongCustodian, 2 OutOfRoute, 3 NotOpen, 4 DuplicateKey, 5 UnknownSource, 6 Paused, 7 Frozen, 8 NotFound, 9 BadRoute, 10 NotFinal, 11 NotFrozen, 12 NoPauser, 13 BadAssurance.

What happens to the token after delivery (burn, transfer, release of funds) is the issuer's policy. It is not part of this record. In our demo, the operator burns the token through the asset's transfer agent after the record shows `Delivered`.

## 5. Events

Each event has two topics: the event name as a symbol (`opened`, `handover`, `attested`, `delivered`, `status_changed`) and the shipment `key`. The data is a map from field name to value. We checked this layout on the `opened`, `handover` and `delivered` events of the live vector in section 7.

| Event | Data |
|---|---|
| `Opened` | `token`, `first_custodian`, `head` |
| `Handover` | `from`, `to`, `seq`, `evidence_hash`, `assurance`, `head` |
| `Attested` | `source`, `kind`, `event_hash`, `head` |
| `Delivered` | `final_custodian`, `holder` |
| `StatusChanged` | `status` (freeze and unfreeze) |

Stellar RPC keeps events only for a limited window, often 7 days or less, so do not rely on events alone to rebuild the chain. Transaction arguments in Horizon history last longer, and `scripts/verify-head.mjs` reads those.

## 6. The head rule

Only `open`, `handover` and `attest` change the head. `deliver`, `freeze` and `unfreeze` change only the status.

```
open:     head = sha256(0x01 || key || docs_root)
handover: head = sha256(0x02 || head || addr(from) || addr(to) || evidence_hash || be32(seq) || be32(assurance))
attest:   head = sha256(0x03 || head || addr(source) || be32(kind) || event_hash || be32(seq))
```

- `||` is byte concatenation. Every hash is the raw 32 bytes, not hex text. `be32` is a 4-byte big-endian unsigned integer.
- In `handover`, `seq` is the new value, after the increment. In `attest`, `seq` is the current value.
- `addr(x)` is the XDR encoding of the Soroban `ScVal` address:
  - An account (`G…`) is 44 bytes: `00000012 00000000 00000000` followed by the 32-byte ed25519 public key.
  - A contract (`C…`) is 40 bytes: `00000012 00000001` followed by the 32-byte contract id.
  - v0.1 covers only account (`G…`) and contract (`C…`) addresses. Other address kinds, such as muxed (`M…`), are out of scope.
- `docs_root`, `evidence_hash` and `event_hash` are 32-byte hashes of documents or evidence kept off chain. This version does not fix how they are built.

## 7. Test vectors

**Offline vector**, shared by the contract's unit tests and `node scripts/verify-head.mjs --selftest`. `s(t)` means `sha256(utf8(t))`. `A` is `GAUTZ4AOL3QBR4OAVXAECCQYQW6MZCTSQ45CUNNXYYIFQZFBGKPZVCLM` and `B` is `GAYOU2QZGAYOMTUHF6N3BO32ZYUEXL52IMJRBOOIRXN6MEOOOB3KERB3`.

| Step | Inputs | Result |
|---|---|---|
| key | `s("TEST1234567\|BRRIO")` | `af078925b6df1601bd50a3a310c3db646311380940c87cc4d20979f32fbc472a` |
| open | `docs_root = s("docs-root-v1")` | `4d27935042faa36a33b9c8726cdf96e8995ce7d33e0e7c0479e37fc14eaf8264` |
| handover | `A → B`, `evidence_hash = s("evidence-1")`, `seq = 1`, `assurance = 3` | `7f75df7c846b6e6389ec1205819f64a0fe96a6d10d385322440973ca27a129f2` |

**Live vector, on Stellar testnet.** This uses the second shipment, where two custodians signed with their own keys.
- Registry: `CD7BUCY3DC7GTHRWFRBHNOFPMGVCHFDL4LHKXZNGEJISSGHI24KSNH3F`.
- Key: `8f32b176a54847894c05b6a60b4400fb7e185c4f28d025f993a56a5639113aae`, which is `sha256("TEST6109555|BRRIO")`.
- Every input below is an argument of a public transaction.

| Step | Transaction | Inputs | Head after |
|---|---|---|---|
| open | `34860ed8…d468` | `docs_root = 4c8c19c179118ecd1473fac669c76f26453e207f2f423da2e6097d2eb3ae633e` | `05b53c24b713b3d5d4569a72578b50635a4b144aa4cedc21acb6e6a80d974d72` |
| handover, seq 1 | `861544e4…0afb` | `GAVDGEJF…5UTZ → GDWNU6TT…TPPW`, evidence `2c92c91a4fb1fc85d94341095e10532b77815f17b42448b9a71e36062fcb9c05`, assurance 3 | `e9dc10432b038cfea47c31e4cf89e693ebc1c2eef8d5f898a48718a1255af5ba` |
| handover, seq 2 | `9214980e…7c0c` | `GDWNU6TT…TPPW → GAUKDWMR…CEFR`, evidence `05020e81990126ad0ab4514729ab4f7c68981c2867dfc9e98bbe6f861c664bf1`, assurance 3 | `eb82cbda0cd42540f0111af08db56fa2f0ff0b7ed60eaf4fcf896257c620201b` |
| handover, seq 3 | `850da342…0e33` | `GAUKDWMR…CEFR → GD54SSZG…2CO4`, evidence `49fbcbc7632d1e45f766447c2d2c991141c8aef0a538ba84ca91fb2c4c165b98`, assurance 3 | `d9cf3a5fef54e57c9202ed73c40ca40ca666bf80f0f6e96b26a008134aa9614d` |
| deliver | `849c268d…2720` | `GD54SSZG…2CO4`, holder `GDL4562Q…WBSK` | unchanged |

On 2026-10-25, the contract's own `head(key)` returned `d9cf3a5f…614d`, the same value as the last row. The full addresses and transaction hashes are in `proofs/three-machine.json`. To check it yourself:

```
PROOF_FILE=proofs/three-machine.json node scripts/verify-head.mjs 8f32b176a54847894c05b6a60b4400fb7e185c4f28d025f993a56a5639113aae
```

The command prints MATCH and exits with 0 when the recomputed head equals the on-chain head. Testnet is reset about once a quarter. After a reset, add `--offline` to check against the transaction copies saved in `proofs/tx/`.

## 8. How a Stellar issuer can implement or reuse it

- **Reuse the contract.** Build `contracts/custody_registry` from [`radox-labs/radox-contracts`](https://github.com/radox-labs/radox-contracts) and deploy your own instance with your own admin and operator (constructor `(admin, operator)`). Your token can be any Soroban token contract, including a Stellar Asset Contract. The registry stores the token's address and never calls it. Apache-2.0 lets you use, change and redistribute it, under the licence's conditions.
- **Implement it yourself.** Any contract or service that keeps the fields in section 3 and the rules in section 4, and computes the head exactly as in section 6, produces heads that any checker can recompute. `verify-head` itself also expects this contract's function names and argument order. Use the vectors in section 7 to test your implementation.
- **Read it.** `get(key)` returns the record and `head(key)` returns the head. Both are read-only, so a backend, a wallet or a page can show custody without holding any key. The public page in this repo does that in the browser.

## 9. Open questions for v0.2

- How `docs_root`, `evidence_hash` and `event_hash` are built. A shared document format would make them comparable across issuers.
- What each `assurance` level (1 to 3) and each attestation `kind` means. Both are plain integers in v0.1.
- Route changes after `open`. A diverted shipment needs a new record today.
- One key per shipment across several registries. Today the key is unique per registry, not globally.
- Who may act as operator and event source when several companies share one registry.

We welcome comments on these questions as issues on this repo.
