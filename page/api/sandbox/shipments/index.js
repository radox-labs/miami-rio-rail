// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// POST /api/sandbox/shipments — open a new test shipment on the sandbox registry.
// Creates the five custodian accounts and the holder (throwaway keys), then calls open().
import { randomInt } from "node:crypto";
import { Operation, Address, nativeToScVal } from "@stellar/stellar-sdk";
import {
  handler, sha, b32, addr, sandboxKeys, operatorKey, invoke, sendClassic, limitIp, checkCap, getShipment,
  SANDBOX_REGISTRY, SANDBOX_TOKEN, ROLES,
} from "../../_lib/rail.js";

export default handler(["POST"], async (req) => {
  limitIp(req, "open", 5, 10 * 60_000);
  await checkCap(operatorKey());
  const container = `SBX${String(randomInt(0, 1e7)).padStart(7, "0")}`; // made-up container number
  const origin = "BRRIO";
  const key = sha(`${container}|${origin}`);
  const keyHex = key.toString("hex");
  const docsRoot = sha(`docs|${container}|sandbox`);
  const { op, stops, holder } = sandboxKeys(keyHex);
  // each custodian pays the fee of the handover it sends; the holder only signs
  const setup = await sendClassic(op, [
    ...stops.map((k) => Operation.createAccount({ destination: k.publicKey(), startingBalance: "3" })),
    Operation.createAccount({ destination: holder.publicKey(), startingBalance: "1" }),
  ]);
  const route = nativeToScVal(stops.map((k) => new Address(k.publicKey())));
  const tx = await invoke(SANDBOX_REGISTRY, "open", [b32(key), addr(SANDBOX_TOKEN), route, b32(docsRoot)], op, {});
  return [201, {
    call: "open",
    tx,
    setup_tx: setup,
    container: `${container}|${origin}`,
    roles: Object.fromEntries([...ROLES.map((r, i) => [r, stops[i].publicKey()]), ["holder", holder.publicKey()]]),
    shipment: await getShipment(SANDBOX_REGISTRY, key),
    next: `POST /api/sandbox/shipments/${keyHex}/handover`,
  }];
});
