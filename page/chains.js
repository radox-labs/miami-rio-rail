// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// "Many supply chains, one rail": the two-company run from proofs/multi-chain.json (multichain.json
// is its page copy). One lane per shipment; each hop links to its testnet transaction.
(() => {
  const box = document.getElementById("lanes");
  const EXPERT = "https://stellar.expert/explorer/testnet/tx/";
  const UNIT = { "A-warehouse": "warehouse", "A-yard": "yard", "A-terminal": "terminal", "B-vessel": "ship", "B-depot": "depot" };
  fetch("multichain.json").then((r) => r.json()).then((d) => {
    const seen = {};
    for (const s of d.shipments) for (const g of s.route) seen[g] = (seen[g] ?? 0) + 1;
    const node = (g) => {
      const u = d.directory[g];
      const n = Object.assign(document.createElement("span"), { className: "node" + (seen[g] > 1 ? " shared" : "") });
      n.append(`${u.company} `, Object.assign(document.createElement("em"), { textContent: UNIT[u.unit] ?? u.unit }));
      return n;
    };
    d.shipments.forEach((s, i) => {
      const lane = Object.assign(document.createElement("div"), { className: "lane" });
      lane.append(Object.assign(document.createElement("h3"), { textContent: `Shipment ${i + 1} · container ${s.container}` }));
      const hops = Object.assign(document.createElement("div"), { className: "hops" });
      hops.append(node(s.route[0]));
      const moves = d.steps.filter((x) => x.shipment === s.container && x.step === "handover");
      for (const m of moves) {
        const ext = m.kind === "external";
        const a = Object.assign(document.createElement("a"), { className: "hop" + (ext ? " ext" : ""), href: EXPERT + m.hash,
          textContent: ext ? "⇒" : "→" });
        a.setAttribute("aria-label", `${ext ? "Between companies" : "Inside a company"}, both confirmed: testnet transaction ${m.hash}`);
        hops.append(a, node(d.shipments[i].route[moves.indexOf(m) + 1]));
      }
      lane.append(hops);
      box.append(lane);
    });
  }).catch(() => { box.textContent = "The two-company view could not load."; });
})();
