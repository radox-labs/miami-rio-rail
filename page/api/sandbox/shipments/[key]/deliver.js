// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// POST /api/sandbox/shipments/:key/deliver — the last company hands the goods to the holder.
import {
  handler, b32, addr, parseKey, sandboxKeys, invoke, limitIp, getShipment, ApiError, SANDBOX_REGISTRY, ROLES,
} from "../../../_lib/rail.js";

export default handler(["POST"], async (req) => {
  limitIp(req, "write", 30, 10 * 60_000);
  const key = parseKey(req.query.key);
  const s = await getShipment(SANDBOX_REGISTRY, key);
  if (!s) throw new ApiError(404, "E_NOT_FOUND", "No sandbox shipment with this key. Open one with POST /api/sandbox/shipments.");
  const { stops, holder } = sandboxKeys(req.query.key);
  if (s.route.some((g, i) => g !== stops[i]?.publicKey())) throw new ApiError(404, "E_NOT_SANDBOX", "This shipment was not opened by the sandbox, so the sandbox holds none of its keys.");
  const last = stops[stops.length - 1];
  // sent even when handovers are missing, so the registry's own refusal (E_NOT_FINAL) shows
  const tx = await invoke(SANDBOX_REGISTRY, "deliver", [b32(key), addr(last.publicKey()), addr(holder.publicKey())], last,
    { [last.publicKey()]: last, [holder.publicKey()]: holder });
  return [200, { call: "deliver", tx, signed_by: [ROLES.at(-1), "holder"], shipment: await getShipment(SANDBOX_REGISTRY, key) }];
});
