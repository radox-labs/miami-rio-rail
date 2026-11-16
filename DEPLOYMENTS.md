# Deployments

## testnet

| What | Value |
|---|---|
| custody_registry contract | `CCBJVXMJYWPHTDJHDFPRGKPGXGEP24JOPJAMUS5C3BMZJTRTWR2H4LII` |
| wasm hash | `8230ed937f443e40054d0806c9cdd044ef341db19f0c1b3123c573adb7a41342` (sha256 of `target/wasm32v1-none/release/custody_registry.wasm`). Built on 2026-10-25 from commit 9b66e00 of the original rail repository; the same bytes now come from `radox-labs/radox-contracts` at the commit in `contracts.lock.json` (rustc 1.99.1, stellar-cli 28.1.0), and `node scripts/verify-contracts-lock.mjs` checks every contract ID against it |
| admin (exporter) | `GAKTDHZIKXNSO7TIAQJAZPZBDLPKYONHDZYQBPYORQPYAH5UYAE7OAHZ` |
| operator (rail operator) | `GCXYI6RYMJQUNO2VFBPUTZ55WBRFVGBTZBOW3YF65ABLGPNNSHX3J4OF` |
| toolchain | soroban-sdk 29.0.1, stellar CLI 28.1.0, protocol 29 |
| deployed | 2026-10-25 |

Other testnet registries, same wasm hash `8230ed93…1342` (checked 2026-10-26 with `stellar contract fetch`):

| What | Value |
|---|---|
| sandbox custody_registry (used by `POST /api/sandbox/shipments`) | `CBTHLSQXQNEZ25UMVRP5TGOCPOTJXLFISJ2EF5NRNITAZPGMMW656ERX` |
| sandbox deploy tx | `4f5f11205505866bcb45760186ab1ab6c7d38c1f4da9cf706cfbe4b6b11b7756` (2026-10-26 04:51 UTC, [Horizon](https://horizon-testnet.stellar.org/transactions/4f5f11205505866bcb45760186ab1ab6c7d38c1f4da9cf706cfbe4b6b11b7756)) |
| sandbox admin and operator | `GBD6DWV7Z4TP6YQHSN7GAABAAFDHB65EFD5MHM4HOZPWSP65GKLXMDSJ` (test key, not in this repo) |
| second shipment registry (`proofs/three-machine.json`) | `CD7BUCY3DC7GTHRWFRBHNOFPMGVCHFDL4LHKXZNGEJISSGHI24KSNH3F` |

Test keys only; no production key is used. Testnet resets wipe this deployment; redeploy from `../radox-contracts/contracts/custody_registry` checked out at the commit in `contracts.lock.json` with:

```sh
stellar contract build
stellar contract deploy --wasm target/wasm32v1-none/release/custody_registry.wasm --source exporter --network testnet -- --admin <G of exporter> --operator <G of rail operator>
```
