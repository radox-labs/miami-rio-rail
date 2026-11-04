// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// GET /api/shipments/:key/history — every registry call for the key, with the head recomputed.
import { handler, parseKey, findShipment, history, limitIp, ApiError } from "../../_lib/rail.js";

// one history costs 20 to 40 calls to the public RPC and Horizon: limit it, and reuse an answer for 20 s
const cache = new Map();

export default handler(["GET"], async (req, N) => {
  const key = parseKey(req.query.key);
  const s = await findShipment(key, N);
  if (!s) throw new ApiError(404, "E_NOT_FOUND", `No shipment with this key on the rail's ${N.name} registries.`);
  // keyed on the head, so a new handover is never answered with the old history
  const ck = `${N.name}|${req.query.key}|${s.head}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < 20_000) return [200, hit.body];
  limitIp(req, "history", 20, 10 * 60_000);
  const h = await history(s.registry, key, N);
  const complete = h.steps[0]?.step === "open";
  const body = {
    shipment: s,
    steps: h.steps,
    recomputed_head: h.recomputed_head,
    head_matches: complete ? h.recomputed_head === s.head : null,
    note: complete
      ? "The head is recomputed here from each transaction's own arguments. To trust no server, recompute it from Horizon with the formula in the docs (the Verify button on /docs does it in your browser)."
      : `The ${N.name} RPC keeps contract events about 7 days; this shipment's opening is older, so the head cannot be recomputed here.`,
  };
  cache.set(ck, { at: Date.now(), body });
  return [200, body];
}, { mainnet: true });
