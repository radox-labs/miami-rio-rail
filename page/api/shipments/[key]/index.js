// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// GET /api/shipments/:key — the shipment's live state from custody_registry (testnet, or ?network=mainnet).
import { handler, parseKey, findShipment, snapshotShipment, ApiError } from "../../_lib/rail.js";

export default handler(["GET"], async (req, N) => {
  const key = parseKey(req.query.key);
  let s;
  try {
    s = await findShipment(key, N);
  } catch (e) {
    const snap = N.name === "testnet" && snapshotShipment(req.query.key);
    if (e instanceof ApiError && e.code === "E_NETWORK" && snap) return [200, { source: "snapshot, not live", shipment: snap }];
    throw e;
  }
  if (!s) throw new ApiError(404, "E_NOT_FOUND", `No shipment with this key on the rail's ${N.name} registries.`);
  return [200, { source: "live", shipment: s, contract: `${N.expert}/contract/${s.registry}` }];
}, { mainnet: true });
