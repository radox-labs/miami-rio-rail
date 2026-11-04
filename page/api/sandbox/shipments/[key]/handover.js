// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// POST /api/sandbox/shipments/:key/handover — the next handover, signed by both companies.
// Body (all optional): { "from": "<role>", "assurance": 1|2|3, "evidence": "<text>" }.
// A "from" that is not the current custodian is sent anyway, so the registry's refusal shows.
import {
  handler, sha, b32, addr, u32, parseKey, sandboxKeys, invoke, limitIp, getShipment, ApiError,
  SANDBOX_REGISTRY, ROLES,
} from "../../../_lib/rail.js";

export default handler(["POST"], async (req) => {
  limitIp(req, "write", 30, 10 * 60_000);
  const key = parseKey(req.query.key);
  const keyHex = req.query.key;
  const body = typeof req.body === "object" && req.body ? req.body : {};
  const s = await getShipment(SANDBOX_REGISTRY, key);
  if (!s) throw new ApiError(404, "E_NOT_FOUND", "No sandbox shipment with this key. Open one with POST /api/sandbox/shipments.");
  const { stops } = sandboxKeys(keyHex);
  if (s.route.some((g, i) => g !== stops[i]?.publicKey())) throw new ApiError(404, "E_NOT_SANDBOX", "This shipment was not opened by the sandbox, so the sandbox holds none of its keys.");
  if (s.status === "Open" && s.seq + 1 >= s.route.length) throw new ApiError(409, "E_ROUTE_COMPLETE", "Every handover is done. Deliver it with POST /api/sandbox/shipments/:key/deliver.");
  // once delivered (or frozen) the last pair is sent again, so the registry's own refusal shows
  const toI = s.status === "Open" ? s.seq + 1 : s.seq;
  const fromI = body.from === undefined ? toI - 1 : ROLES.indexOf(body.from);
  if (fromI < 0) throw new ApiError(400, "E_ROLE", `"from" must be one of: ${ROLES.join(", ")}.`);
  if (fromI === toI) throw new ApiError(400, "E_ROLE", `"from" cannot be the receiving company (${ROLES[toI]}).`);
  const assurance = body.assurance ?? 3;
  if (!Number.isInteger(assurance) || assurance < 0 || assurance > 1000) throw new ApiError(400, "E_ASSURANCE", "\"assurance\" must be a whole number (1, 2 or 3 are accepted by the registry).");
  const evidence = sha(String(body.evidence ?? `sandbox-evidence|${keyHex}|${s.seq + 1}`));
  const from = stops[fromI], to = stops[toI];
  const keys = { [from.publicKey()]: from, [to.publicKey()]: to };
  // the outgoing company sends the transaction (pays its fee); the incoming one signs its auth entry
  const tx = await invoke(SANDBOX_REGISTRY, "handover",
    [b32(key), addr(from.publicKey()), addr(to.publicKey()), b32(evidence), u32(assurance)], from, keys);
  return [200, {
    call: "handover",
    tx,
    from: ROLES[fromI], to: ROLES[toI],
    signed_by: [ROLES[fromI], ROLES[toI]],
    evidence_hash: evidence.toString("hex"),
    shipment: await getShipment(SANDBOX_REGISTRY, key),
  }];
});
