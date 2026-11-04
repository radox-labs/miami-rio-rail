// Copyright 2026 the rio-miami-rail contributors
// SPDX-License-Identifier: Apache-2.0

// The story globe: Rio–Miami route on an orthographic globe, one step per real testnet
// transaction, lit as the visitor scrolls. Reduced motion: every step lit, drawn once.
// Reads snapshot.json for the steps (the hashes) so it never waits for the Stellar SDK.
(() => {
  const canvas = document.getElementById("globe");
  const cap = document.getElementById("caption");
  const list = document.getElementById("steps");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const col = (n, a) => (a == null ? `hsl(${tok(n)})` : `hsl(${tok(n)} / ${a})`);
  const EXPERT = "https://stellar.expert/explorer/testnet/tx/";
  const DONE = "Done. One shared record followed the test shipment from Rio to Miami, confirmed at every handover. Anyone can check it.";

  const RIO = [-43.18, -22.9], MIAMI = [-80.19, 25.77];
  const along = d3.geoInterpolate(RIO, MIAMI);
  const CENTER = [62, -2]; // rotation that puts the Atlantic between Rio and Miami in front
  // where each named custodian sits on the route (0 = Rio, 1 = Miami)
  const T = { warehouse: 0, port: 0.02, carrier: 0.5, customs: 0.98, recipient: 1, leo: 0.35, vhendala: 0.7 };
  const LABEL = { warehouse: "the warehouse", port: "the port", carrier: "the ship", customs: "customs", recipient: "the buyer",
    leo: "Leo", vhendala: "Vhendala", holder: "the token holder" };

  let land, snapshot, steps = [], at = 0, shown = 0, rot = CENTER.slice(), anim = 0, drag = null;

  function caption(s, i) {
    const a = LABEL[s.from], b = LABEL[s.to];
    if (s.step === "open") return "A container leaves a warehouse in Rio. The rail opens one shared record for it.";
    if (s.step === "handover") {
      if (s.to === "carrier") return "The port hands the container to the ship. Both confirm.";
      if (s.from === "carrier") return "The ship reaches Miami and hands it to customs. Both confirm.";
      if (s.to === "recipient" && s.from === "customs") return "Customs releases the container to the buyer. Both confirm.";
      const own = s.from === "leo" || s.to === "leo" || s.from === "vhendala" || s.to === "vhendala";
      return `${cap1(a)} hands the container to ${b}. Both confirm${own ? ", each on their own computer" : ""}.`;
    }
    if (s.step === "deliver") return "The buyer and the token holder both confirm delivery. The record is complete.";
    if (s.step === "redeem") return "The token that stood for the cargo is retired. The goods have arrived.";
    return s.step;
  }
  const cap1 = (x) => x[0].toUpperCase() + x.slice(1);

  // one step per transaction, from the saved proof: who handed to whom
  function build(i) {
    const p = snapshot.shipments[i];
    const name = Object.fromEntries(Object.entries(p.actors).map(([n, g]) => [g, n]));
    const route = (p.shipment.route ?? ["warehouse", "port", "carrier", "customs", "recipient"].map((n) => p.actors[n])).map((g) => name[g]);
    let k = 0;
    steps = p.lifecycle.map((x) => {
      const s = { step: x.step, hash: x.hash };
      if (x.step === "handover") { s.from = route[k]; s.to = route[k + 1]; k += 1; }
      s.t = T[x.step === "open" ? route[0] : route[k]] ?? k / (route.length - 1);
      return s;
    });
    steps.route = route;
    list.replaceChildren(...steps.map((s, j) => {
      const li = document.createElement("li");
      li.append(caption(s, j));
      const sm = document.createElement("small");
      const a = Object.assign(document.createElement("a"), { href: EXPERT + s.hash, textContent: `${s.hash.slice(0, 8)}…` });
      a.setAttribute("aria-label", `Testnet transaction ${s.hash}`);
      sm.append(`${s.step} · testnet transaction `, a);
      li.append(sm);
      return li;
    }));
    if (still) { light(steps.length - 1); at = shown = steps[steps.length - 1].t; draw(); }
    else { light(-1); at = shown = 0; cap.textContent = "Scroll down: the container is about to leave Rio."; draw(); watch(); }
  }

  function light(j) {
    [...list.children].forEach((li, n) => li.classList.toggle("done", n <= j));
    cap.textContent = j < 0 ? cap.textContent : j === steps.length - 1 ? DONE : caption(steps[j], j);
    at = j < 0 ? 0 : steps[j].t;
  }

  let io;
  function watch() {
    io?.disconnect();
    io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { light([...list.children].indexOf(e.target)); go(); }
    }, { rootMargin: "-45% 0px -45% 0px" });
    for (const li of list.children) io.observe(li);
  }

  // animate the container from where it is shown to where the last lit step put it
  function go() {
    cancelAnimationFrame(anim);
    const from = shown, t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / 900), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      shown = from + (at - from) * e;
      draw();
      if (k < 1) anim = requestAnimationFrame(tick);
    };
    anim = requestAnimationFrame(tick);
  }

  function draw() {
    if (!land) return;
    const dpr = Math.min(2, devicePixelRatio || 1), w = canvas.clientWidth || 300;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = canvas.height = Math.round(w * dpr); }
    const S = canvas.width, c = canvas.getContext("2d");
    const proj = d3.geoOrthographic().scale(S * 0.46).translate([S / 2, S / 2]).rotate(rot).clipAngle(90);
    const path = d3.geoPath(proj, c);
    c.clearRect(0, 0, S, S);
    c.beginPath(); path({ type: "Sphere" }); c.fillStyle = col("--card"); c.fill();
    c.lineWidth = 1 * dpr; c.strokeStyle = col("--border"); c.stroke();
    c.beginPath(); path(land); c.fillStyle = col("--border"); c.fill(); c.strokeStyle = col("--muted-foreground", 0.35); c.stroke();
    const arc = { type: "LineString", coordinates: d3.range(0, 1.0001, 0.02).map(along) };
    c.beginPath(); path(arc); c.setLineDash([4 * dpr, 5 * dpr]); c.strokeStyle = col("--muted-foreground", 0.7); c.lineWidth = 1.5 * dpr; c.stroke(); c.setLineDash([]);
    if (shown > 0) {
      c.beginPath(); path({ type: "LineString", coordinates: d3.range(0, shown + 1e-6, 0.01).map(along).concat([along(shown)]) });
      c.strokeStyle = col("--primary"); c.lineWidth = 3 * dpr; c.stroke();
    }
    // stops: lime once the container has reached or passed them
    const stops = [...new Set(steps.map((s) => s.t))];
    for (const t of stops) {
      const p = proj(along(t)); if (!p) continue;
      c.beginPath(); c.arc(p[0], p[1], 5 * dpr, 0, 2 * Math.PI);
      c.fillStyle = t <= at + 1e-9 && steps.some((s, j) => s.t === t && list.children[j]?.classList.contains("done")) ? col("--primary") : col("--border");
      c.fill();
    }
    // the container
    const q = proj(along(shown));
    if (q) {
      const z = 9 * dpr; c.fillStyle = col("--primary"); c.fillRect(q[0] - z / 2, q[1] - z / 2, z, z);
      c.strokeStyle = col("--background"); c.lineWidth = 2 * dpr; c.strokeRect(q[0] - z / 2, q[1] - z / 2, z, z);
    }
    c.font = `600 ${13 * dpr}px Inter, system-ui, sans-serif`;
    c.fillStyle = col("--foreground");
    for (const [ll, txt, dx] of [[RIO, "Rio de Janeiro", 10], [MIAMI, "Miami", 10]]) {
      const p = proj(ll); if (!p) continue;
      // keep the label inside the canvas: put it left of the dot when it would run off the right edge
      const wtxt = c.measureText(txt).width, right = p[0] + dx * dpr + wtxt <= S - 2 * dpr;
      c.fillText(txt, right ? p[0] + dx * dpr : p[0] - dx * dpr - wtxt, p[1] + 4 * dpr);
    }
  }

  // drag to turn; the globe eases back to the Atlantic when let go
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, r: rot.slice() }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    rot = [drag.r[0] + (e.clientX - drag.x) * 0.4, Math.max(-60, Math.min(60, drag.r[1] - (e.clientY - drag.y) * 0.4))];
    draw();
  });
  const release = () => {
    if (!drag) return; drag = null;
    if (still) return;
    const from = rot.slice(), t0 = performance.now();
    const back = (now) => {
      const k = Math.min(1, (now - t0) / 1200), e = 1 - (1 - k) ** 3;
      rot = [from[0] + (CENTER[0] - from[0]) * e, from[1] + (CENTER[1] - from[1]) * e];
      draw(); if (k < 1 && !drag) requestAnimationFrame(back);
    };
    setTimeout(() => !drag && requestAnimationFrame(back), 1500);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  addEventListener("resize", () => draw());

  const pick = () => (location.hash === "#shipment-2" ? 1 : 0);
  for (const b of document.querySelectorAll("#switch button")) b.addEventListener("click", () => setTimeout(() => build(Number(b.dataset.s)), 0));
  addEventListener("hashchange", () => build(pick()));

  Promise.all([fetch("vendor/land-110m.geo.json").then((r) => r.json()), fetch("snapshot.json").then((r) => r.json())])
    .then(([l, s]) => {
      land = l; snapshot = s;
      if (!still) { rot = [CENTER[0] + 40, CENTER[1] + 8]; } // a short settle onto the Atlantic
      build(pick());
      if (!still) {
        const from = rot.slice(), t0 = performance.now();
        const settle = (now) => {
          const k = Math.min(1, (now - t0) / 1600), e = 1 - (1 - k) ** 3;
          if (!drag) rot = [from[0] + (CENTER[0] - from[0]) * e, from[1] + (CENTER[1] - from[1]) * e];
          draw(); if (k < 1) requestAnimationFrame(settle);
        };
        requestAnimationFrame(settle);
      }
    })
    .catch(() => { cap.textContent = "The globe could not load. The proof below still works."; });
})();
