# Radox Rail

**Você conferir os contratos que estão listados abaixos nesse repositório** -> [Acessar Radox Contracts](https://github.com/radox-labs/radox-contracts)


> **Versão `miami-rio-rail` para `radox-labs`.** Esta é uma cópia independente do projeto original
> `pwsaragossy/radox-rail`. O código e os testes de `custody_registry` foram movidos
> para `radox-labs/radox-contracts`; o Rail mantém a demonstração, a API sandbox,
> as provas e os scripts específicos do corredor. O texto abaixo documenta também
> a implementação e as provas históricas do hackathon; referências a caminhos
> `contracts/custody_registry` devem ser lidas no repositório de contratos.

**A container crosses a border through several companies and agencies (for example a warehouse, a port, a carrier, customs and the buyer), and each keeps its own records. No record is shared among them, so none of them can check what the others say about who held the goods. The money that rides on those records is large: the WTO says 80 to 90 per cent of world trade relies on trade finance. Radox Rail is a shared record that each company on the route signs into, like SWIFT for goods: at each handover, the company giving the goods and the company receiving them both sign, the step is added to a hash chain that no one can rewrite (an administrator can freeze a shipment but cannot change past steps), and anyone who needs to know (the buyer, an insurer, a lender) can check the whole history against one 32-byte value stored on the contract. This repo is its first piece, running on Stellar testnet: a Soroban contract where every handover is authorised by both custodians, hash-chained, and checkable by anyone from public data.**

*First corridor: Rio–Miami.*

Live page: <https://rio-miami-rail.vercel.app> · Video: {{fill: video URL}} · Network: Stellar **testnet demo; mainnet proof with test accounts** · Licence: Apache-2.0

## Problem

About 45 million ocean bills of lading are issued a year ([DCSA, Feb 2023](https://dcsa.org/newsroom/dcsas-member-carriers-commit-to-a-fully-standardised-electronic-bill-of-lading-by-2030), 2021 data); in 2025 about 11% were issued electronically ([DCSA, as of 2025](https://dcsa.org/newsroom/understanding-soft-barriers-to-digital-adoption)). 22% of recorded cargo thefts in 2025 involved insiders ([TT Club & BSI Cargo Theft Report, Apr 2026](https://www.ttclub.com/fileadmin/uploads/tt-club/Documents/Corporate_Literature/TT_Club_BSI_2025_Cargo_Theft_Report_FINAL.pdf)). The [WTO](https://www.wto.org/english/thewto_e/coher_e/tr_finance_e.htm) (page undated) says 80 to 90 per cent of world trade relies on trade finance (trade credit and insurance/guarantees), and ADB estimates the global trade finance gap at about US$2.5 trillion, unchanged from 2023 ([ADB Global Trade Finance Gap Survey, Dec 2025](https://www.adb.org/publications/adb-global-trade-finance-gap-survey)). These are market figures, not results of this repo. A container that crosses a border changes hands many times: warehouse, port, carrier, customs, recipient. Each party keeps its own record, and a token that represents the cargo has no trustworthy link to where the cargo physically is. Whoever holds the token cannot check the custody history without trusting the party that reports it.

Ports and airports run legacy systems that are hard to integrate. With the rail, each company will integrate once, not pair by pair: a legacy system will join through one adapter to the Radox API, and a financier can read which custodian last signed for the goods before paying.

## What it does

One shipment is one record in the `custody_registry` contract, keyed by `sha256(container | origin)`. Its life:

1. **Open.** The rail operator registers the shipment with its route (ordered custodians), the token and a documents root. Needs the operator's authorisation.
2. **Handover.** Each custodian passes the cargo to the next one on the route. The call requires `require_auth()` from both `from` and `to`, plus an assurance level 1 to 3. Wrong custodian, out-of-route and bad assurance are refused.
3. **Attest.** An allow-listed data source (for example a gate scanner) adds an event hash to the chain without moving custody.
4. **Deliver.** The final custodian and the token holder both authorise; refused until every handover on the route is done.
5. **Redeem (burn).** After `Delivered`, the cargo token is burned through the asset's transfer agent. This step uses prior work (see [Prior work](#prior-work)); the contract does not enforce it, the harness checks the status first.

Each step folds into a single 32-byte `head`, so one value commits to the whole history. Admin controls exist: freeze (for lost or seized cargo), pause, and an allow-list of data sources.

The record format, its rules, events, head rule and test vectors are written up as a proposed open spec in [CUSTODY-SPEC.md](CUSTODY-SPEC.md), so that another Stellar issuer can implement it or reuse this contract under Apache-2.0.

## Live demo

Open <https://rio-miami-rail.vercel.app>. It reads the shipment from Stellar testnet, lists each transaction, and has a **Check the fingerprint** button that recomputes the head in your browser. If testnet cannot be reached it shows a saved snapshot, labelled "Snapshot, not live". Video walkthrough: {{fill: video URL}}.

The demo runs on Stellar testnet with generated test keys, and `TEST4627832` is a test cargo ID. Every handover needs both custodians' authorisation, enforced by the contract.

## Open API (testnet)

Open API: <https://rio-miami-rail.vercel.app/docs>. Read any shipment (`GET /api/shipments/{key}`), check its history and head (`GET /api/shipments/{key}/history`), and run a shipment in a testnet sandbox with no key or account (`POST /api/sandbox/shipments`, then `/handover` and `/deliver`; limited to 5 new shipments per 10 minutes per IP address and about 20 per hour for everyone, after which it answers 429 `E_SANDBOX_CAP`; reading is not counted in this cap, though per-IP read limits still apply). Each successful handover is a real testnet transaction that needs both companies' authorisation: the one giving the goods signs the transaction, and the one receiving them signs a Soroban authorisation entry inside it (see [Architecture](#architecture)). The sandbox companies are throwaway test accounts whose keys the server holds. The API's head check covers shipments opened in the last ~7 days, because the testnet RPC keeps contract events that long; older ones answer `head_matches: null`, and `scripts/verify-head.mjs` still checks them from Horizon. `?network=mainnet` supports read-only access to the mainnet proof registry; sandbox writes remain testnet-only. To run your own handovers on the rail beyond the sandbox, write to pedro@radox.net. If the sandbox is busy, read the finished example shipment: `GET /api/shipments/31b4cff785831659b4ecb8fd3e7382f9760a12ef45ef7eb30f45b3b6911a5e37` and its `/history`.

This API is served from this repo's deployment on Vercel and reads and writes only the open `custody_registry` contract. It is not the Radox platform API described under [Prior work](#prior-work), which is closed and not exposed here.

## Quick verify

Needs Node 20 or newer. About two minutes, no keys, no secrets.

```sh
git clone https://github.com/radox-labs/miami-rio-rail && cd miami-rio-rail
npm ci
node scripts/verify-head.mjs --selftest        # fixed vector, shared with the contract's unit test
node scripts/verify-head.mjs 31b4cff785831659b4ecb8fd3e7382f9760a12ef45ef7eb30f45b3b6911a5e37
```

The second command reads the shipment's transactions from Horizon, recomputes the head with the byte layout below, and compares it with `head(key)` read from the contract. Output of a run on 2026-10-25 14:30 UTC (clone of commit 54dc401):

```text
open     ledger 5381140 2b3d51f0cdf1… seq 0 head 4b293344de96edc442fb1e53f5bd275e702664abcf4688a41a2abd7e5494b6b3
handover ledger 5381142 635c99ac73cb… seq 1 head f9027c56f9026467e78de9e955c7b3e47325c72746c756a8cfe8a7c7a08f8c5a
handover ledger 5381143 56a0f006e337… seq 2 head a6a1be3bcca6d845a011e4aa32db350e8afbb7ac14049f3f3d7649166504c8a7
attest   ledger 5381144 333792115c7a… seq 2 head 172b7408401dc548c3ceee2612c8e1debb876607801acde75d4d47f56beccc7e
handover ledger 5381145 ac268a49e00d… seq 3 head 53a54097694f20a7d0d9635a84fb888822774bd77ead74410c767cb09425ba12
handover ledger 5381146 5199d4fb6b28… seq 4 head 2d74fec064a6796c34be93ede6241e0e067650dcfb2e058382f2f9cf83195414
recomputed 2d74fec064a6796c34be93ede6241e0e067650dcfb2e058382f2f9cf83195414
on-chain   2d74fec064a6796c34be93ede6241e0e067650dcfb2e058382f2f9cf83195414
MATCH
```

List the seven lifecycle transactions, then check who authorised each handover:

```sh
jq -r '.lifecycle[] | "\(.step)\t\(.hash)"' proofs/lifecycle.json
node scripts/handover-signers.mjs               # exit 0: both custodians signed every handover and the delivery
curl -s https://horizon-testnet.stellar.org/transactions/<hash> | jq '{successful, ledger}'
```

Add `--offline` to `verify-head.mjs` to check against the saved copies in `proofs/tx/` when testnet has been reset.

## Setup and environment

| Need | Version used |
|---|---|
| Node.js | 20 or newer (26.12.0 here) |
| `@stellar/stellar-sdk` | 17.3.0 (pinned in `package.json`) |
| Rust | 1.97.1, targets `wasm32v1-none` and the host target |
| Stellar CLI | 28.1.0 |
| `soroban-sdk` | 29.0.1 |

```sh
cd ../radox-contracts/contracts/custody_registry
cargo test                     # contract tests run in the contract repository
stellar contract build         # builds the wasm in this independent crate
```

Environment variables, all optional; defaults point at public testnet endpoints:

- `HORIZON_URL`, `RPC_URL`: override the Horizon and Soroban RPC endpoints.
- `REGISTRY`, `EXPORTER_SECRET`, `OPERATOR_SECRET`: only for `npm run lifecycle`, to reuse an existing registry and its admin and operator. Without them the harness deploys its own registry and generates fresh test keys, never written to disk.
- `REGISTRY_WASM_HASH`: wasm hash for that deploy.

The **Request access** form on the page posts to `POST /api/access` (`page/api/access.js`, at most 3 requests per 10 minutes per IP), which emails the team through Resend. Vercel environment variables:

- `RESEND_API_KEY`: Resend API key. Without it the API answers 503 `E_EMAIL_NOT_CONFIGURED` and the form opens a pre-filled `mailto:pedro@radox.net` instead.
- `ACCESS_TO`: recipient (default `pedro@radox.net`). `ACCESS_FROM`: sender (default `Radox Rail <onboarding@resend.dev>`; use an address on a domain verified in Resend).

`node scripts/access.test.mjs` checks the endpoint offline (stubbed `fetch`, no email sent).

`npm run lifecycle` replays the whole shipment on testnet (it funds test accounts through Friendbot) and rewrites `proofs/`. Deployment details and the redeploy command are in [DEPLOYMENTS.md](DEPLOYMENTS.md).

## Architecture

```text
 custodians (test keys) ──auth entries──▶ custody_registry (Soroban, testnet)
 rail operator ──signs the transaction──▶   │  head = hash chain per shipment
                                            ▼
 Horizon (history) ──▶ scripts/verify-head.mjs, page/ ──▶ recompute head, compare with head(key)
 Radox API (private) ──▶ reads get(key) from the same contract
```

- **Contract.** `custody_registry` on Stellar testnet: `CCBJVXMJYWPHTDJHDFPRGKPGXGEP24JOPJAMUS5C3BMZJTRTWR2H4LII` (wasm hash `8230ed93…1342`, source in `contracts/custody_registry/`). The shipment key is `31b4cff7…5e37`. The cargo token is a Stellar asset contract (`CBCWTIT5YNPNSA4ZSJJXUFZKGQROZPWNWYNZ4CSO7HLWJXU7Z6N5Q22Z`) and its transfer agent instance is `CAYD3EFTN6YOHMHJ5C62WYGABBIN2G6MV5MLHUKWV2EVJP5FFTKXSJWH`.
- **Head byte layout** (`contracts/custody_registry/src/lib.rs`, SHA-256; `be32` is a 4-byte big-endian integer, `addr` the XDR bytes of the address):
  - open: `sha256(0x01 || key || docs_root)`
  - handover: `sha256(0x02 || head || addr(from) || addr(to) || evidence_hash || be32(seq) || be32(assurance))`
  - attest: `sha256(0x03 || head || addr(source) || be32(kind) || event_hash || be32(seq))`
  - `deliver`, `freeze` and `unfreeze` do not change the head. The fixed vector in `--selftest` is also asserted in the contract's unit tests.
- **History from Horizon.** The head is recomputed from each transaction's own arguments read from Horizon, not from contract events, because the RPC keeps events for only about seven days.
- **Authorisation.** Custodians authorise inside the contract call with `require_auth()` on Soroban authorisation entries. A block explorer shows only the transaction source's envelope signature (the operator). `scripts/handover-signers.mjs` lists the custodians' signed entries from the saved envelopes.
- **Page.** Static files in `page/`, served on Vercel. It shows both testnet shipments (a switch; `#shipment-2` opens the second), uses the vendored browser bundle of stellar-sdk 17.3.0, reads Soroban RPC and Horizon, and falls back to `page/snapshot.json`.
- **Radox API (historical branch).** A private development branch of the Radox platform backend exposed `GET /api/custody/shipments/<key>`, which read `get(key)` from this contract. The current `radox-core` checkout does not contain that route. In a local development run on 2026-10-25 (the full backend started against a throwaway database, testnet only) the call returned status `Delivered`, `seq` 4 and head `2d74fec0…5414`, the same head as `verify-head` above.

**Ask one question, get the answer.** A company on the route, or a financier, will be able to ask the Radox API, `GET /api/custody/shipments/:key`, and get the shipment's status, current custodian, route and number of signed handovers, read from this contract. The endpoint is in the closed Radox backend; it ran only in a local development run on testnet and is not publicly hosted.

## Testnet transactions

Seven lifecycle transactions, plus one attestation. All eight were checked on 2026-10-25 against `https://horizon-testnet.stellar.org/transactions/<hash>` and report `successful: true`. Copies of the Horizon responses are in `proofs/tx/`.

| # | Step | Contract called | Ledger | Transaction hash |
|---|---|---|---|---|
| 1 | open | custody_registry | 5381140 | `2b3d51f0cdf113d34a7c20dd373142c379926bd3bd24ca0a9cb6d4718e379902` |
| 2 | handover warehouse → port | custody_registry | 5381142 | `635c99ac73cb13416e6b52f29ac9a067fbc615e01b8de962eb36245db3f0bd38` |
| 3 | handover port → carrier | custody_registry | 5381143 | `56a0f006e3373df34c96ae7b0f02c4b66753ccaca6ccc48fe5125bb65e7b7cc2` |
| – | attest (gate event) | custody_registry | 5381144 | `333792115c7a93abdbf4a45dc217b4bb332c69d14f95095d7d0dffc9d0068905` |
| 4 | handover carrier → customs | custody_registry | 5381145 | `ac268a49e00ddf4745c9026bf01e3c77e5c451a7e2396100ef590a36ecc3c4b2` |
| 5 | handover customs → recipient | custody_registry | 5381146 | `5199d4fb6b2833662327deecbf5fcaf058a0d7a464f97974edd107f5de400b7a` |
| 6 | deliver | custody_registry | 5381147 | `919def8c0b3f29ae650f5f1ea6d632e49efd4a9442381c84c83d858ad2144e37` |
| 7 | redeem (burn) | transfer agent (prior work) | 5381148 | `864fd1644d30bf708a59f94ca5b0fc303a50deccfd96099bd32dfb67e215644d` |

Six transactions call the new contract; transaction 7 calls prior work. `proofs/lifecycle.json` also records nine refused calls (wrong custodian, out of route, wrong signer, early delivery, bad assurance, duplicate key and others), run by simulation.

### Second shipment: two custodians with their own keys

In a second testnet shipment, two team members authorised their own handovers, each with their own testnet key. Only public keys and signed authorisation entries were exchanged; the operator's machine checked each entry against the request and submitted the transactions. The other keys in that shipment (warehouse, recipient, holder and operator) are our test keys on one machine. Route Warehouse → Leo → Vhendala → Recipient, on a second registry deployed from the same wasm (`CD7BUCY3DC7GTHRWFRBHNOFPMGVCHFDL4LHKXZNGEJISSGHI24KSNH3F`):

| Step | Transaction | Ledger |
|---|---|---|
| handover 1, Warehouse → Leo | `861544e40a137a89b2ae209d8efaf81b973d4cd451686c5c441a7a16b3d90afb` | 5384199 |
| handover 2, Leo → Vhendala | `9214980ea8f3923ca0e036a803517dba2b3d1c1a12d8e5cbb481f31625eb7c0c` | 5384200 |
| handover 3, Vhendala → Recipient | `850da3429eb00af3f752dfe4804bd506acbc19f0aebe194402fb7b4fbd260e33` | 5384201 |
| deliver | `849c268d0d84c414cfb1e0634c4967f811ee7bb08c3d72e8255cb75e78b52720` | 5384202 |

Proof and tool: [`proofs/three-machine.json`](proofs/three-machine.json) and [`scripts/remote-auth.mjs`](scripts/remote-auth.mjs). Check it with `PROOF_FILE=proofs/three-machine.json node scripts/verify-head.mjs 8f32b176a54847894c05b6a60b4400fb7e185c4f28d025f993a56a5639113aae` (MATCH). This shipment records custody only: it points at the first shipment's asset contract and has no mint or redeem of its own.

### One rail, several supply chains: two companies on one registry

One registry can carry custody chains that belong to different companies, with the existing contract and no new code. On a separate testnet registry (`CDDWEENF6DKM4AHFWDBHQTYPLC3STMVFPXHXYDORLD53WDZM3FF3KJX4`), two shipments ran across two test companies:

- Shipment `TEST3286578`: A-warehouse → A-terminal (internal to company A) → B-vessel (A to B) → B-depot (internal to company B), then delivered.
- Shipment `TEST3286579`: A-yard → A-terminal → B-vessel, then delivered. It shares the A-terminal and B-vessel stops with the first shipment.

Each handover was signed by both custodians, and each shipment keeps its own head, so the two chains are tracked separately. The registry sees only addresses: which company and unit an address belongs to comes from a directory kept off chain, in the proof file, and is not a contract field. Custody moves; ownership and money stay where they are.

| Step | Transaction |
|---|---|
| deploy registry | `328ceaa90b084925c2ac64c732982fa2749223dba3bd739d64b7d1ce8a6d77b7` |
| open `TEST3286578` | `ac1ca8e47b03b9799aa1dc2f9e06b612a6105262428274c15b3d5d7b61a8edd3` |
| open `TEST3286579` | `b189aec42c2e5202f0d72de11d4f50c9d8a41005820eb8ef47ee2cea7d65b10e` |
| `TEST3286578` A-warehouse → A-terminal | `9a810a33610eedabd55d6c8addb8e328d264a00ffabb71cb5a95129b7826b0ba` |
| `TEST3286579` A-yard → A-terminal | `98136578af52f769ab13079b32b340f815e39177ece7212226f54f2e5197ed24` |
| `TEST3286578` A-terminal → B-vessel | `7d75acbd94faa8a8e4435e31c1cd50bebf1408588554ed3c2a7abd9cde16c4e3` |
| `TEST3286579` A-terminal → B-vessel | `3ea5237fa295fb2abb6a612a116323ec2d76c04501c4a5344014752062b3b8f5` |
| `TEST3286578` B-vessel → B-depot | `81555aa1db5c47a93f912ab3312f6b243cd449ba86f59cef59274b4d49a7b41c` |
| deliver `TEST3286578` | `c0f4457107a13bc1b5a0f1004ab0b30c57572822dfb772dd69084cab50f7cc68` |
| deliver `TEST3286579` | `c7aad14f25ac62eb2553db8f9f4a41014b5fc93fc37a0e39c3e751a9b1df6105` |

Proof and tool: [`proofs/multi-chain.json`](proofs/multi-chain.json) and [`scripts/multi-chain.mjs`](scripts/multi-chain.mjs). Check each shipment with `PROOF_FILE=proofs/multi-chain.json node scripts/verify-head.mjs 404c2ca977251e7c4139143161814def648a92094d5dff63c2694c89b9adddeb` (`TEST3286578`) and the same command with `836ec9f9bc09a08a3ef445f1bdd6d1094ba3222d8651fb2c82100274cc497b8a` (`TEST3286579`); both print MATCH.

### Mainnet

**Deployed on Stellar mainnet on 2026-10-26.** The same build (wasm `8230ed93…`) is the registry [`CDV7YI7K…WS7LD4UP`](https://stellar.expert/explorer/public/contract/CDV7YI7KYTDH4LPOLVUVRTFERJKYOWBBT6KS56ZX3V7EOGDBWS7LD4UP). The admin is a Ledger hardware wallet: it signed the account funding, the upload and the deploy on the device. One shipment ran there: open, 4 handovers signed by both companies, and the delivery, with 9 transactions, all successful on mainnet Horizon. The final status is `Delivered`, seq 4. Hashes are in `proofs/mainnet.json`; the script is `scripts/mainnet-deploy.mjs`. The API reads it with `?network=mainnet`. The custodians are test accounts, and no goods or money move. The sandbox and the token flow stay on testnet.

### Mainnet rehearsal (local fork, nothing sent)

**Rehearsed against mainnet state.** The same contract build (wasm `8230ed93…`) ran its custody lifecycle (without the token and burn steps) against a local fork of Stellar mainnet (soroban-sim, protocol 29): all 15 transactions applied, all 9 refusal branches were refused, and the run was charged 13.72 XLM in fees (`scripts/mainnet-rehearsal.mjs`, `proofs/mainnet-rehearsal.json`). Nothing was sent to mainnet; the mainnet deploy is a later signing ceremony.

## Prior work

Disclosed as required. Before HackMeridian (2026-10-25 09:00 UTC) we built **Radox**, a platform for tokenized real-world assets:

- Three Soroban contracts (`token_sale`, `yield_distributor`, `maturity_settlement`) run on Stellar mainnet (June-July 2026). Their source is public, contracts only, at <https://github.com/pwsaragossy/radox> since 2026-08-19; the published `token_sale` is a newer version (v8) than the one deployed (v7), the other two match.
- The Radox backend, `radox-internal`, is closed and not published. It is prior work and is not part of this submission's repo.
- Redeem in transaction 7 calls an instance of Radox's existing `transfer_agent` contract, deployed on testnet from its existing wasm (hash `3870748b…fc6bff1`, `scripts/lifecycle.mjs`). It was prior work and was not written at the event. Its source was closed at submission time; the intended new home is `radox-labs/radox-contracts`.
- Nothing from the public Radox repo was copied into this repo. That repo carries its own, different licence.
- Design and planning before the event: an architecture review of the custody idea on 2026-10-20 (design notes only, no code) and planning documents dated 2026-10-24 and 2026-10-25 (kick-off, task brief, pitch outline). The GitHub repository was created empty on 2026-10-24 22:49 UTC so the team could be invited. No contract code was written before 2026-10-25 09:00 UTC; the first commit is at 09:00:17.

### Prior-work interfaces this repo uses

Both were prior work and their source was closed at the time of the hackathon submission. This is exactly what this repo calls or shows, so a judge can check each row against testnet. The `transfer_agent` source is being migrated to `radox-labs/radox-contracts`.

#### The `transfer_agent` contract (prior work): what this repo calls

Instance `CAYD3EFTN6YOHMHJ5C62WYGABBIN2G6MV5MLHUKWV2EVJP5FFTKXSJWH` on testnet, wasm `3870748b709f7b8531c7ebbbc975712333f61949831350ff7192f7076fc6bff1`. Types come from `stellar contract info interface` (CLI 28.1.0, read 2026-10-25). The output is the same for `--id` and `--wasm-hash`, and `stellar contract fetch --id` returns a wasm whose sha256 equals that hash. Signers come from the decoded `auth` entries of each transaction envelope. Effects come from Horizon `asset_balance_changes` on the cargo token `CBCWTIT5…Q22Z` (RMR1). Actors are the ones in `proofs/lifecycle.json` → `actors`. 

| entrypoint | parameters (interface) | require_auth signers (observed, tx) | effect on the Stellar Asset Contract (observed) | called at |
|---|---|---|---|---|
| `__constructor` | `config: Config { admin: Address, operator: Address }` | exporter, as the deploy's `source_account` credential. There is one auth entry (`create_contract_v2`), and `__constructor` is its sub-invocation. Tx `3c724975…`. Args: `admin` = exporter, `operator` = operator. | None. The tx has no balance changes. | `scripts/lifecycle.mjs:149-150` (via `deploy()`, lines 97-104) |
| `register_token` | `token: Address, seller: Address, settlement: Address, payment_asset: Address` → `Result<(), AgentError>` | admin (exporter) only, as an address credential. The tx source is the operator. Tx `6661aaf0…`. In the Step 0b spike (own instance `CBOM5ZZR…`), a second call returned `AgentError #2 AlreadyRegistered`, and register_token also succeeded before `set_admin` (`f223037b…`). | None. Stores `TokenReg { payment_asset, seller, settlement }` (type from the interface; the storage write itself is not confirmed). This repo passes seller = seller, settlement = exporter, payment_asset = the native XLM SAC. | `scripts/lifecycle.mjs:166-167` |
| `mint` | `token: Address, to: Address, amount: i128` → `Result<(), AgentError>` | admin (exporter), as an address credential. The tx source is the operator. Tx `eb86ea5b…`. | `mint` 1.0000000 RMR1 to the seller. It runs after `sac.set_admin(agent)` (tx `0056254f…`, signed by the issuer). | `scripts/lifecycle.mjs:168` |
| `deliver` | `token: Address, to: Address, amount: i128` → `Result<(), AgentError>` | the registered seller, as an address credential. The tx source is the operator. Tx `ebbc04f7…`. | `clawback` 1.0000000 from the seller, then `mint` 1.0000000 to the holder. This is not a SAC `transfer`. | `scripts/lifecycle.mjs:169-170` |
| `redeem` | `token: Address, holder: Address, amount: i128, ref_id: u64` → `Result<(), AgentError>` | operator (`source_account` credential) and holder (address credential). Tx `864fd164…`. The Step 0b spike (`7f8a6829…`) also needed operator + holder. | `clawback` 1.0000000 from the holder. Holder balance goes 10000000 → 0 (`holder_balance_after_redeem: "0"`, a read after the tx). | `scripts/lifecycle.mjs:204-205`, after the Delivered check at lines 200-202 |

<details>
<summary>Interface functions this repo does not call. For all of them, signers and effects are not confirmed.</summary>

| entrypoint | parameters (interface) |
|---|---|
| `update_token` | `token, seller, settlement, payment_asset: Address` |
| `set_payees` | `token: Address, payees: Vec<Address>` |
| `set_primary_price` | `token: Address, price_per_unit: i128` |
| `pay` | `token: Address, payer: Address, usdc: Address, legs: Vec<Leg { amount: i128, to: Address }>, ref_id: u64` |
| `transfer_dvp_split` | `seller: Address, buyer: Address, token: Address, token_amount: i128, usdc: Address, legs: Vec<Leg>, ref_id: u64` |
| `transfer_dvp` | `seller: Address, buyer: Address, token: Address, token_amount: i128, usdc: Address, usdc_amount: i128` |
| `admin_transfer` | `token: Address, from: Address, legs: Vec<Leg>, ref_id: u64` |
| `clawback` / `admin_clawback` | `token: Address, from: Address, amount: i128` |
| `set_authorized` / `admin_set_authorized` | `token: Address, addr: Address, authorized: bool` |
| `hand_over_sac` | `token: Address, new_admin: Address`. Reading it as the exit path that moves the SAC admin away from the agent is an inference from the signature. |
| `set_operator` / `propose_admin` | `operator` / `new_admin: Address` |
| `accept_admin`, `pause`, `resume`, `renounce_emergency_pauser`, `emergency_pause` | none |
| `set_emergency_pauser` | `pauser: Option<Address>` |
| `upgrade` | `new_wasm_hash: BytesN<32>` |
| reads: `version` → u32, `get_paused` → bool, `emergency_pauser` → Option<Address>, `get_config` → Config, `get_token(token)` → Option<TokenReg>, `is_registered(token)` → bool, `get_payees(token)` → Vec<Address>, `get_primary_price(token)` → Option<i128> | as listed |

</details>

`AgentError` codes (interface): 1 NotRegistered, 2 AlreadyRegistered, 3 InvalidAmount, 4 NoPendingAdmin, 5 NotPendingAdmin, 6 InsufficientBalance, 7 WrongPaymentAsset, 8 TooManyLegs, 9 PayeeNotRegistered, 10 EmptyLegs, 11 PriceNotSet, 12 BelowPrimaryPrice, 13 Paused, 14 NoEmergencyPauser.

- **Prior work.** `transfer_agent` was built before HackMeridian (2026-10-25 09:00 UTC), and this repo deployed it as-is. It was closed source at submission time. The wasm code entry was last modified at testnet ledger 5060574 (2026-10-06 22:40:57 UTC, from `lastModifiedLedgerSeq`; the upload transaction was not looked up).
- **The registry does not gate redeem on chain.** `custody_registry` never calls the agent. The harness reads the shipment and stops unless the status is `Delivered` (`scripts/lifecycle.mjs:200-202`), and only then calls `redeem`. The agent itself does not check custody; that statement should be verified against the migrated source.
- **Observed vs inferred.** Observed: the parameter types, the auth entries in each envelope (decoded with `stellar xdr decode`), the Horizon balance changes, and the holder balance 0. The redeem row can be checked offline in `proofs/tx/864fd164….json`. The setup txs (`3c724975`, `6661aaf0`, `eb86ea5b`, `ebbc04f7`, `0056254f`) are not saved in `proofs/tx/` and can be checked on Horizon testnet. Inferred: that the agent holds the SAC admin role and uses it for mint and clawback, and the `TokenReg` storage. Not confirmed: the internal checks of any function, and every function in the second table.

#### Radox API: `GET /api/custody/shipments/:key` (closed, prior platform)

The endpoint lives in Radox's closed platform backend, which is not in this repo. The backend was built before the event; the endpoint itself was written on 2026-10-25 on a private branch. It is a read-only wrapper over this contract. Anyone can get the same data with no Radox code: call `custody_registry.get(key)` directly, as `page/app.js` (`onchainShipment`) and `scripts/verify-head.mjs` do.

| | |
|---|---|
| Method, path | `GET /api/custody/shipments/:key` |
| `:key` | 64 hex characters: the 32-byte shipment key, `sha256(container \| origin)`, for example `31b4cff7…5e37` for `TEST4627832\|BRRIO` |
| Auth | None. The data is public chain data. The route is rate-limited: 300 requests per 60-second window per client, from the `RateLimit-Policy: 300;w=60` header |
| What it does | Builds a `get(key)` call to `custody_registry` and runs it through Soroban RPC `simulateTransaction`. It sends no transaction, needs no signature and charges no fee |
| `200 OK` | `{ "success": true, "data": { "key", "contract", "status", "currentCustodian", "route", "seq", "head", "holder" } }` |
| Errors | `400` with `{ "success": false, "code": "E_CUSTODY_KEY" }` when `:key` is not 64 hex characters; `404` with `{ "success": false, "code": "E_CUSTODY_NOT_FOUND" }` when the contract has no shipment for that key |

`data` fields:

| Field | Type | From the contract |
|---|---|---|
| `key` | string, 64 hex | the shipment key |
| `contract` | string, `C…` contract ID | the `custody_registry` instance that was read |
| `status` | `"Open"`, `"Frozen"` or `"Delivered"` | `Shipment.status` |
| `currentCustodian` | string, `G…` address | `Shipment.current_custodian` |
| `route` | array of `G…` addresses, in order | `Shipment.route` |
| `seq` | integer | `Shipment.seq`, the number of handovers done |
| `head` | string, 64 hex | `Shipment.head`, the same value `verify-head.mjs` recomputes |
| `holder` | `G…` address, or `null` before delivery | `Shipment.holder` |

Observed on 2026-10-25 at 13:17 UTC (route test) and 13:23 UTC (full backend boot), testnet, key `31b4cff7…5e37`. The response was `200` with `status` `Delivered`, `seq` 4 and head `2d74fec0…5414`, equal to `verify-head`. An unknown key gave `E_CUSTODY_NOT_FOUND`, and the key `zz` gave `E_CUSTODY_KEY`. The recorded run kept the response bodies, not the status lines of the two error calls, so the `400` and `404` codes come from the endpoint's documented contract (the comment above `onchainShipment` in `page/app.js`). They are not shown in that recording. Judges cannot run this endpoint from this repo.

## Built at HackMeridian

All commits are dated 2026-10-25 UTC or later, starting at `d10cb84` (09:00:17). Built here:

- `contracts/custody_registry`: the contract, 24 unit tests, 2 property tests and their snapshots.
- `scripts/lifecycle.mjs` and `scripts/lib/stellar.mjs`: the testnet harness that runs the whole shipment with per-custodian authorisation.
- `scripts/verify-head.mjs`, `scripts/handover-signers.mjs`, `scripts/page-snapshot.mjs`: independent head recomputation, signer listing, snapshot generation.
- `scripts/remote-auth.mjs`: prepare, sign and submit a handover whose custodians each sign with their own key (second shipment).
- `proofs/`: four proof sets: the lifecycle record, the second shipment's record and the two-company record, with Horizon copies of their transactions, and the mainnet-fork rehearsal (`scripts/mainnet-rehearsal.mjs`).
- `page/`: the public shipment page, with the Check the fingerprint button and snapshot fallback.
- `page/api/` and `page/docs/`: the open testnet API (read, history, keyless sandbox) and its reference page with an OpenAPI 3.1 spec (first commit `4c0af66`, 2026-10-26 04:57 UTC).
- The testnet deployment (`DEPLOYMENTS.md`) and the Apache-2.0 licence setup.

## AI usage

AI coding agents wrote the contract and its tests, the harness and verification scripts, the page, and the documentation files. Generated files (`proofs/`, `page/snapshot.json`, `test_snapshots/`) come from running our scripts and tests. A human developer on the team reviewed the contract's functions, auth checks and error codes, the dependency pin, and the signing logic in the harness. AI agents checked the page, and further AI reviewers examined its code and design. The seven lifecycle hashes were also checked on Horizon by an AI agent. [AI_USAGE.md](AI_USAGE.md) lists the files, how each was made and who reviewed it. Outside the repo: the pitch deck was built by scripts an AI agent wrote, and the video narration is an AI voice generated from Pedro's voice.

## Stellar ecosystem

custody_registry is an open Apache-2.0 Soroban contract that stores a token address and never calls the token, so any tokenized Stellar asset can carry a custody record. Radox will open API access to Stellar issuers. Stellar holds about US$4 billion in tokenized real-world assets (SDF, as of 1 Sep 2026), and we found no Stellar project that records a handover signed by two custodians (LumenLoop directory and SCF submissions, plus Scout for SEPs, searched 24–25 Oct 2026).

## Market and business model

The corridor we target, US–Brazil goods trade, was about US$94.2 billion in 2025 (exports plus imports, US Census Bureau). Brazil was Florida's largest goods export market in 2025 at US$6.1 billion (USTR). World merchandise exports were US$26.26 trillion in 2025 (WTO, Mar 2026). Ocean carriers issue around 45 million bills of lading a year (DCSA, Feb 2023).

Business model: a recurring fee per connected institution plus a fee per shipment. It borrows the shape of SWIFT's published fee structure: Swift, a cooperative owned by its members, charges an entry fee, annual charges (including network connection) and network-usage fees on message traffic (swift.com billing rules, accessed 25 October 2026). We are not affiliated with Swift.

## Production path

The build runs on Stellar testnet. The path to mainnet:

1. **Mainnet gating.** Physical-asset offers on the Radox platform stay blocked outside testnet until the full test matrix is proven.
2. **Issuer lock.** On mainnet the asset issuer account must be locked after the asset contract's admin moves to the transfer agent. The testnet run does not do this: the issuer keeps its master key.
3. **Audit.** We plan to request an audit through the SDF Audit Bank, which is open to projects funded by the Stellar Community Fund in its eligible categories (financial protocols among them) and requires a threat model first (see below). So the audit follows an SCF award.
4. **Evidence lifetime.** Testnet resets about quarterly (next on 2026-12-16) and the RPC keeps events about seven days, so the committed Horizon copies and the video are what remain after a reset.
5. **Funding.** Next, an SCF Build application, with this contract as its first milestone.

## Threat model and known limits

What the contract enforces, and where its boundaries are.

| Threat | Enforced on chain? | How, or why not |
|---|---|---|
| A custodian hands over without the other side agreeing | Yes | `handover` calls `require_auth()` on both `from` and `to`. The property test `prop_handover_needs_both_custodians` draws random signer sets from {from, to, two strangers} (64 seeded cases); every set without both custodians is refused and `seq` and `head` are unchanged. Two named unit tests cover each single-signer case. |
| Skipping a stop, going backwards, or delivering early | Yes | `to` must be the next stop, `from` the current custodian, and `deliver` needs `seq` at the last stop (errors #1, #2, #10). The property test `prop_route_invariants_and_head_chain` runs random routes (with revisits) and random call sequences against a model (64 seeded cases). |
| Rewriting or reordering history in an off-chain copy (an indexer or database) | Yes, detectable | Each step folds into the 32-byte `head`. Anyone replays the transactions from Horizon and compares (`scripts/verify-head.mjs`, MATCH on every shipment in `proofs/`). The head verifies history; it cannot rebuild it. |
| Replaying a signature, or reusing it for another call | Yes, by the Soroban host | Each auth entry is signed over the network, a nonce, an expiry ledger and one invocation (contract, function, arguments), and the nonce is used once. Off chain, `scripts/remote-auth.mjs sign` refuses entries for another registry, other functions, sub-calls or unknown addresses before signing; it trusts the registry address it is given. A signed entry stays valid until its expiry and can be submitted by whoever holds it. |
| Custodians that collude, or keys held by one party | No | Two colluding custodians can sign a handover that never happened. The head proves who signed, not that the cargo moved. In our first shipment one harness held every key. In the second shipment, two of the four custodians (Leo and Vhendala) signed with their own keys; the other keys were ours. |
| Lost custodian key | Partly | A shipment stops at that stop. The admin can `freeze` it ("lost or seized cargo"). There is no key rotation inside a shipment. |
| A powerful admin | Limited | The admin can freeze or unfreeze, pause or resume, set one emergency pauser, and add or remove event sources. It cannot change a route, a custodian or past head values. A pause stops writes on every shipment. The admin and operator keys cannot be rotated. The contract has no upgrade function: a new version is a new deploy. |
| The operator alone chooses the route | No | `open` needs only the operator's signature; custodians consent at their own handover. A wrong route cannot be corrected: the key is taken (`DuplicateKey`), and the exit is `freeze`. |
| A custodian refuses to sign | No | Any custodian on the route can stop the shipment by not signing. There is no timeout; the admin can `freeze`. |
| Event sources (`attest`) | Limited | A registered source can add an attestation to any shipment, in any status (including Delivered and Frozen); it blocks nothing and changes the `head`. The admin decides who is a source. |
| What a handover attests | No | `evidence_hash` and `assurance` (1 to 3) are chosen by the two custodians; the contract does not check what the hash points to. |
| Who can read | Public | `get` and `head` need no signature, and all state and events are public on chain. Nothing confidential goes in a key, a route or an evidence input. |
| State archival | Mitigated | Writes to a shipment extend the instance and that shipment to about 30 days (518,400 ledgers) when under 7 days remain. Source entries are extended when added or used. The instance bump also extends the contract code (soroban-sdk 29.0.1 `instance().extend_ttl` calls `extend_current_contract_instance_and_code_ttl`). An idle shipment or source can archive, and it can be restored. |
| Delivering to someone who does not hold the token, or burning without delivery | No | `deliver` needs the signature of the `holder` address it is given, but the registry never checks that this address holds the token, and `open` never checks that `token` is a real token. The registry does not gate the burn either: `Delivered` is checked by our script before it calls the Radox `transfer_agent` (`scripts/lifecycle.mjs`), not on chain. In the demo, `redeem` (tx `864fd164…`) was signed by the operator and the holder and took the holder's balance to 0. |
| A second token, or a paper bill of lading, for the same cargo | No | Not prevented on chain: the registry records custody, not title. |
| Bugs in the contract | Not ruled out | 26 tests pass (24 unit, 2 seeded property tests). A review before the testnet deploy led to the fixes in commit `9b66e00`. It has not been audited. |

## Future

Radox is a platform for tokenized real-world assets; its three Soroban contracts (token_sale, yield_distributor, maturity_settlement) run on Stellar mainnet since June-July 2026 (see [Prior work](#prior-work)). Radox Rail, on Stellar testnet, is our next step from tokenized assets to goods in transit: it adds to a tokenized asset a record of who holds the goods, signed by both companies at each handover. We aim to grow it into a shared, SWIFT-like standard for custody of goods across trade corridors. Rio–Miami is our first corridor, not the product. Radox is part of the Rio–Miami trade-corridor initiative and its technology rail: every port, airport and chamber that joins it will join the rail, through one adapter to the Radox API. Radox is in conversations with chambers of commerce in Brazil and Miami. The custody record is published as an open spec, [CUSTODY-SPEC.md](CUSTODY-SPEC.md), so any Stellar issuer can implement it or reuse this contract.

Next: connect the rail to the Radox platform's physical-asset flow (a read-only Radox API endpoint already reads this registry in a local development run); let Stellar issuers run their own shipments on the rail, beyond the [open testnet sandbox](#open-api-testnet) that is live now; run the first live shipment with a financial institution and a port or logistics operator; apply to SCF Build with this contract as its first milestone. The rail reaches mainnet after an audit and the issuer-account lock described in [Production path](#production-path).

## Team

- Pedro Saragossy, founder
- Leo Schlanger, developer
- Vhendala, supervision and product review

## Licence

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Dependencies, checked on 2026-10-25: 215 Rust crates in `Cargo.lock`, all permissive (MIT, Apache-2.0, BSD, Zlib, Unlicense, or dual combinations); 41 npm packages in `package-lock.json` (38 MIT, 2 Apache-2.0, 1 BSD-3-Clause). No GPL, LGPL, AGPL or MPL. `page/stellar-sdk.min.js` is the unmodified browser bundle of stellar-sdk 17.3.0 (Apache-2.0). The page loads the Inter font (SIL OFL 1.1) from Google Fonts.
