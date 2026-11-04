// One-screen story for a lay executive: a three.js dot globe of trade lanes plus 7 scenes, one at a time. No scrolling.
import * as THREE from "./vendor/three.module.min.js";
import { ICONS } from "./vendor/icons.js";

const gsap = window.gsap;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const D = Math.PI / 180;
const LIME = 0xc6f24e, SOFT = 0xc8cbd0, GREY = 0x8a8f98, CARD = 0x131517;

// ---------- scene ----------
const canvas = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(Math.max(devicePixelRatio, 1.5), 2)); // supersample on 1x screens so thin lanes do not stair-step
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
const globe = new THREE.Group();
scene.add(globe);

const vec = (lat, lon, r = 1) => new THREE.Vector3(
  r * Math.cos(lat * D) * Math.cos(lon * D), r * Math.sin(lat * D), -r * Math.cos(lat * D) * Math.sin(lon * D));

globe.add(new THREE.Mesh(new THREE.SphereGeometry(0.985, 64, 64), new THREE.MeshBasicMaterial({ color: CARD })));
const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.05, 96, 96), new THREE.ShaderMaterial({
  side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  vertexShader: "varying vec3 n; void main(){ n = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
  fragmentShader: "varying vec3 n; void main(){ float i = pow(clamp(0.72 - dot(n, vec3(0.0,0.0,1.0)), 0.0, 1.0), 4.0); gl_FragColor = vec4(0.78,0.95,0.31,1.0) * i * 0.3; }",
}));
scene.add(atmo);

// Land dots: rasterise land-110m once, then keep the Fibonacci points that fall on land.
async function landDots() {
  const geo = await fetch("vendor/land-110m.geo.json").then((r) => r.json());
  const W = 1024, H = 512, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const proj = window.d3.geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, H / 2]);
  ctx.fillStyle = "#fff"; ctx.beginPath(); window.d3.geoPath(proj, ctx)(geo); ctx.fill();
  const px = ctx.getImageData(0, 0, W, H).data, pts = [], N = 22000, g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, lat = Math.asin(y) / D, lon = (((i * g) / D) % 360) - 180;
    const x = Math.floor(((lon + 180) / 360) * W), yy = Math.floor(((90 - lat) / 180) * H);
    if (px[(yy * W + x) * 4 + 3] > 128) pts.push(...vec(lat, lon, 1.002).toArray());
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  globe.add(new THREE.Points(bg, dotMat));
}
// round, anti-aliased dots that thin out at the limb (square points stacked into a noisy band there)
const dotMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { color: { value: new THREE.Color(GREY) }, scale: { value: 450 } },
  vertexShader: `uniform float scale; varying float face;
    void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); face = dot(normalize(normalMatrix * position), normalize(-mv.xyz));
      gl_PointSize = max(2.0, 0.02 * scale / -mv.z); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform vec3 color; varying float face;
    void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = 1.0 - smoothstep(0.7, 1.0, d);
      a *= 0.9 * smoothstep(0.02, 0.3, face); if (a < 0.01) discard; gl_FragColor = vec4(color, a); }`,
});
landDots().catch(() => {});

const icon = (name) => `<span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg></span>`;
for (const i of document.querySelectorAll("i[data-icon]")) i.outerHTML = icon(i.dataset.icon);
const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => x * x * (3 - 2 * x);

// ---------- the global network: many trade lanes, many shipments at once ----------
const HUBS = {
  santos: [-23.96, -46.33], farm: [-11.4, -61.4], chicago: [41.9, -87.6], rio: [-22.9, -43.2], miami: [25.8, -80.2], ny: [40.7, -74], panama: [9, -79.5],
  la: [34, -118.2], rotterdam: [51.9, 4.5], hamburg: [53.5, 10], lisbon: [38.7, -9.1], lagos: [6.5, 3.4],
  durban: [-29.9, 31], dubai: [25.2, 55.3], mumbai: [19, 72.8], singapore: [1.3, 103.8], shanghai: [31.2, 121.5],
  tokyo: [35.6, 139.7], sydney: [-33.9, 151.2],
};
const LANES = [["santos", "hamburg"], ["rio", "miami"], ["santos", "lagos"], ["ny", "rotterdam"], ["miami", "lisbon"],
  ["panama", "la"], ["la", "shanghai"], ["la", "tokyo"], ["rotterdam", "dubai"], ["hamburg", "ny"], ["lagos", "durban"],
  ["durban", "mumbai"], ["dubai", "mumbai"], ["mumbai", "singapore"], ["singapore", "shanghai"], ["singapore", "sydney"],
  ["shanghai", "tokyo"], ["santos", "durban"], ["dubai", "singapore"], ["panama", "rio"], ["santos", "rotterdam"],
  ["farm", "rio"], ["miami", "chicago"]];
const network = new THREE.Group();
globe.add(network);
const moverGeo = new THREE.BoxGeometry(0.016, 0.016, 0.034);
function laneCurve(a, b) {
  const va = vec(...HUBS[a]), vb = vec(...HUBS[b]), ang = va.angleTo(vb), pts = [];
  for (let k = 0; k <= 64; k++) { const t = k / 64; pts.push(va.clone().lerp(vb, t).normalize().multiplyScalar(1 + (0.04 + 0.22 * ang / Math.PI) * Math.sin(Math.PI * t))); }
  return new THREE.CatmullRomCurve3(pts);
}
const lanes = LANES.map(([a, b], i) => {
  const curve = laneCurve(a, b), mat = new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0.45, depthWrite: false });
  const mover = new THREE.Mesh(moverGeo, new THREE.MeshBasicMaterial({ color: LIME, transparent: true }));
  const hl = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.0055, 12, false), new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0, depthWrite: false }));
  network.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 128, 0.0022, 8, false), mat), mover, hl);
  return { id: a + "-" + b, curve, mat, mover, hl, speed: 0.05 + 0.04 * ((i * 7) % 5) / 5, off: (i * 0.37) % 1 };
});
const lane = (id) => lanes.find((l) => l.id === id);
lane("panama-rio").hl.material.color.setHex(SOFT);
// scene 1: one container hops farm -> Rio -> Miami -> buyer, one handover at each stop
// the ship leg follows open water: off Bahia and Recife, round the Brazilian bulge, off the Guianas,
// east of the Lesser Antilles, north of Hispaniola and through the Bahamas to Miami; it stops once at sea
const AT_SEA = [-3, -31], SEA_ALT = 1.006;
const SEA_WAY = [HUBS.rio, [-23.6, -41.5], [-20, -38.4], [-13, -37], [-8, -33.6], AT_SEA, [1, -38.5], [4.5, -47], [8.5, -54.5],
  [12, -58.5], [16.5, -59.5], [19.6, -64], [21.2, -69], [23.4, -72.6], [26.1, -76.3], [26, -78.6], HUBS.miami];
// round the waypoint polygon on the unit sphere (Chaikin, endpoints kept), then join the points with great-circle (slerp) steps
let SEA_POLY = SEA_WAY.map((ll) => vec(...ll));
for (let it = 0; it < 3; it++) {
  const out = [SEA_POLY[0]];
  for (let i = 0; i < SEA_POLY.length - 1; i++) {
    const a = SEA_POLY[i], b = SEA_POLY[i + 1];
    if (i > 0) out.push(a.clone().lerp(b, 0.25).normalize());
    if (i < SEA_POLY.length - 2) out.push(a.clone().lerp(b, 0.75).normalize());
  }
  out.push(SEA_POLY[SEA_POLY.length - 1]); SEA_POLY = out;
}
const SEA_PTS = [];
SEA_POLY.slice(1).forEach((b, i) => {
  const a = SEA_POLY[i], ang = a.angleTo(b), n = Math.max(1, Math.ceil(ang / D / 0.4)), axis = a.clone().cross(b).normalize();
  for (let k = i ? 1 : 0; k <= n; k++) SEA_PTS.push(a.clone().applyAxisAngle(axis, (ang * k) / n).multiplyScalar(SEA_ALT));
});
const SEA_CUT = (() => { const t = vec(...AT_SEA, SEA_ALT); return SEA_PTS.reduce((m, p, i) => (p.distanceTo(t) < SEA_PTS[m].distanceTo(t) ? i : m), 0); })();
const SEA_STOP = SEA_PTS[SEA_CUT];
// the sea leg in the rail's own lime, dashed: same family as the lanes, read as "by ship" by the pattern, fades at the limb
function seaLeg(pts) {
  const curve = new THREE.CatmullRomCurve3(pts);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { color: { value: new THREE.Color(LIME) }, opacity: { value: 0 }, dashes: { value: Math.round(curve.getLength() / 0.03) } },
    vertexShader: `varying float u; varying float face;
      void main(){ u = uv.x; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        face = dot(normalize(normalMatrix * position), normalize(-mv.xyz)); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 color; uniform float opacity; uniform float dashes; varying float u; varying float face;
      void main(){ float f = fract(u * dashes); float w = fwidth(u * dashes);
        float on = smoothstep(0.0, w, f) * (1.0 - smoothstep(0.6 - w, 0.6, f));
        float a = opacity * 0.95 * on * smoothstep(0.0, 0.25, face); if (a < 0.01) discard; gl_FragColor = vec4(color, a); }`,
  });
  const hl = new THREE.Mesh(new THREE.TubeGeometry(curve, 600, 0.0045, 10, false), mat);
  network.add(hl);
  return { curve, hl };
}
const SEA_LEGS = [seaLeg(SEA_PTS.slice(0, SEA_CUT + 1)), seaLeg(SEA_PTS.slice(SEA_CUT))];
const CHAIN = [lane("farm-rio"), ...SEA_LEGS, lane("miami-chicago")];
const boxGeo = new THREE.BoxGeometry(0.024, 0.024, 0.052), shade = [];
for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) { const k = [0.78, 0.78, 1, 0.62, 0.9, 0.9][f]; shade.push(k, k, k); } // fixed light from above
boxGeo.setAttribute("color", new THREE.Float32BufferAttribute(shade, 3));
const chainBox = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: LIME, vertexColors: true, transparent: true }));
chainBox.add(new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), new THREE.LineBasicMaterial({ color: 0x0e0f11, transparent: true })));
// where the container is at a moment of hop i: it rests a little short of each stop, on the line, not on the hub;
// it travels by arc length on the same curves the lines are drawn from, so it is always centred on its line
const LENS = CHAIN.map((l) => l.curve.getLength()), REST_D = 0.06;
function chainAt(i, k) {
  const startD = i === 0 ? REST_D : 0, back = i === 0 ? 0 : Math.min(REST_D, LENS[i - 1] / 3);
  const d = -back + (back + LENS[i] - REST_D - startD) * k + startD;
  if (d < 0) { const u = 1 + d / LENS[i - 1]; return { curve: CHAIN[i - 1].curve, u }; }
  return { curve: CHAIN[i].curve, u: Math.min(1, d / LENS[i]) };
}
network.add(chainBox);
const LEG = 2.4, STOP = 0.8, CYCLE = CHAIN.length * (LEG + STOP) + 1.5;
const hubMat = new THREE.MeshBasicMaterial({ color: LIME, transparent: true });
const ringGeo = new THREE.RingGeometry(0.02, 0.0235, 64);
const hubs = Object.entries(HUBS).map(([id, ll], i) => {
  const p = vec(...ll, 1.003), dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 12), hubMat);
  dot.position.copy(p);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: LIME, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  ring.position.copy(p); ring.lookAt(p.clone().multiplyScalar(2));
  network.add(dot, ring);
  return { id, p, ring, off: i * 0.29 };
});

// ---------- HTML labels pinned to the globe ----------
const pinsEl = document.getElementById("pins");
const pin = (text, cls = "") => { const el = document.createElement("div"); el.className = "pin " + cls; el.textContent = text; pinsEl.append(el); return el; };
const LABELS = {
  shared: pin("Token on Stellar · who owns it", "tag"), rio: pin("Rio de Janeiro"), miami: pin("Miami"),
  coffee: pin("Coffee · example", "lit"), other: pin("Custody record · who holds it, signed", "lit"),
  warehouse: pin("Warehouse"), trucker: pin("Trucker"), ship: pin("Ship · Port of Rio"), transit: pin("Ship · stop at sea"), customs: pin("Customs · Miami"), buyer: pin("Buyer"),
};
LABELS.rio.dataset.dy = "40%"; LABELS.shared.dataset.dy = "-250%"; LABELS.other.dataset.dy = "60%"; LABELS.warehouse.dataset.dy = "40%";
LABELS.trucker.dataset.dx = "10%"; LABELS.ship.dataset.dx = "10%"; LABELS.buyer.dataset.dx = "15%"; LABELS.customs.dataset.dx = "-115%"; LABELS.customs.dataset.dy = "-20%"; LABELS.coffee.dataset.dy = "-230%";
const STOPS = ["warehouse", "trucker", "ship", "transit", "customs", "buyer"];
LABELS.transit.dataset.dx = "-112%";

// what the globe does in each scene (scenes 1, 2, 4 and 5 are illustrations over a dimmed globe)
const VIEW = {
  0: { yaw: -30, pitch: 4, zoom: 0.72, hl: { "farm-rio": 1, "miami-chicago": 1 }, labels: ["coffee", ...STOPS] },
  3: { yaw: -32, pitch: 4, hl: { "rio-miami": 1 }, labels: ["shared", "other"] },
  7: { yaw: -30, pitch: 4, spin: true, hl: { "rio-miami": 1 }, labels: ["rio", "miami"] },
};
const DIMMED = new Set([1, 2, 4, 5, 6, 8]);

// drag to turn the globe
let yaw = -32 * D, pitch = 0, dragging = null, held = 0;
canvas.addEventListener("pointerdown", (e) => { dragging = { x: e.clientX, y: e.clientY, yaw, pitch }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  yaw = dragging.yaw + (e.clientX - dragging.x) * 0.006;
  pitch = Math.max(-1, Math.min(1, dragging.pitch + (e.clientY - dragging.y) * 0.004));
});
addEventListener("pointerup", () => { if (dragging) held = performance.now(); dragging = null; });

let baseZ = 5.2;
function layout() {
  const w = innerWidth, h = innerHeight, narrow = w <= 820;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  baseZ = narrow ? 6.4 : 5.2;
  camera.position.set(0, 0, baseZ);
  camera.updateProjectionMatrix();
  dotMat.uniforms.scale.value = h * renderer.getPixelRatio() / 2;
  const off = narrow ? new THREE.Vector3(0, 0.8, 0) : new THREE.Vector3(0.62 * (w / h) * 0.85, 0, 0);
  globe.position.copy(off); atmo.position.copy(off);
}
addEventListener("resize", layout);
layout();

const tmp = new THREE.Vector3(), camDir = new THREE.Vector3();
function place(el, local, show) {
  tmp.copy(local).applyMatrix4(globe.matrixWorld);
  camDir.copy(camera.position).sub(tmp);
  const facing = tmp.clone().sub(globe.position).dot(camDir) > 0;
  tmp.project(camera);
  // keep the label inside the viewport (a 390 px phone cut "Ship · Port of Rio")
  const w = el.offsetWidth, dx = parseFloat(el.dataset.dx || "-50") / 100 * w;
  const x = Math.max(8, Math.min(innerWidth - w - 8, (tmp.x * 0.5 + 0.5) * innerWidth + dx));
  const h = el.offsetHeight, y = (-tmp.y * 0.5 + 0.5) * innerHeight + parseFloat(el.dataset.dy || "-140") / 100 * h;
  Object.assign(el, { _x: x, _y: y, _w: w, _h: h, _on: show && facing });
  el.style.opacity = el._on ? 1 : 0;
  return el;
}
// pins placed later move clear of earlier ones (the moving "Coffee" pin went under "Trucker" on phones)
function settle(els) {
  const done = [];
  for (const el of els) {
    let y = el._y;
    if (el._on) {
      for (let pass = 0; pass < 3; pass++) for (const o of done) {
        if (el._x < o._x + o._w + 4 && o._x < el._x + el._w + 4 && y < o._ry + o._h + 4 && o._ry < y + el._h + 4)
          y = el._y < o._ry ? o._ry - el._h - 4 : o._ry + o._h + 4;
      }
      done.push(el);
    }
    el._ry = y;
    el.style.transform = `translate(${el._x}px, ${y}px)`;
  }
}

let current = -1, sceneStart = performance.now(), last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const st = (now - sceneStart) / 1000, intro = reduce ? 1 : ease(clamp(st / 1.2));
  const v = VIEW[current] || VIEW[current < 3 ? 0 : current < 7 ? 3 : 7];
  if (!dragging && now - held > 3000) {
    if (v.spin && !reduce) yaw += dt * 0.1;
    else { const d = Math.atan2(Math.sin(v.yaw * D - yaw), Math.cos(v.yaw * D - yaw)); yaw += d * Math.min(1, dt * 2.5); }
    pitch += (v.pitch * D - pitch) * Math.min(1, dt * 2.5);
  }
  // scene 1 zooms in so each leg reads as a real trip
  const z = baseZ * (v.zoom || 1); camera.position.z += (z - camera.position.z) * Math.min(1, dt * 2);
  globe.rotation.set(pitch, yaw, 0);
  globe.updateMatrixWorld();

  const sec = reduce ? 0 : now / 1000, dim = DIMMED.has(current);
  lanes.forEach((l, i) => {
    const t = (sec * l.speed + l.off) % 1;
    l.mover.position.copy(l.curve.getPointAt(t));
    l.mover.lookAt(l.curve.getPointAt(Math.min(1, t + 0.01)).applyMatrix4(globe.matrixWorld));
    // last scene: lanes light up one by one after Rio–Miami
    const wave = current === 7 ? (reduce ? 1 : clamp((st - 1.5 - i * 0.18) / 0.6)) : 1;
    l.mat.opacity = (current === 7 ? 0.12 + 0.43 * wave : 0.45) * (dim ? 0.5 : 1);
    l.mover.material.opacity = current === 7 ? wave : 1;
    const hl = !dim && v.hl[l.id] ? intro : 0;
    l.hl.material.opacity = hl * (current === 7 ? 0.6 + 0.4 * Math.sin(now / 300) : 1);
  });
  for (const h of hubs) { const k = (sec * 0.6 + h.off) % 1; h.ring.scale.setScalar(1 + k * 1.5); h.ring.material.opacity = (1 - k) ** 2 * 0.7; }

  const show = (k) => !dim && v.labels.includes(k) && intro > 0.5;
  // the container hops leg by leg; each company appears as the cargo reaches it
  const c = reduce ? CYCLE - 1.5 : Math.max(0, st) % CYCLE, legI = Math.min(CHAIN.length - 1, Math.floor(c / (LEG + STOP)));
  const { curve: leg, u } = chainAt(legI, ease(clamp((c - legI * (LEG + STOP)) / LEG)));
  chainBox.position.copy(leg.getPointAt(u));
  const wp = chainBox.position.clone().applyMatrix4(globe.matrixWorld);
  chainBox.up.copy(wp).sub(globe.position).normalize(); // container sits upright on the globe
  chainBox.lookAt(chainBox.position.clone().add(leg.getTangentAt(u)).applyMatrix4(globe.matrixWorld));
  chainBox.visible = current === 0;
  // fade with the line at the limb
  const faceBox = chainBox.up.dot(camDir.copy(camera.position).sub(wp).normalize()), boxA = Math.min(1, Math.max(0, faceBox / 0.25));
  chainBox.material.opacity = chainBox.children[0].material.opacity = boxA;
  SEA_LEGS.forEach((l) => { l.hl.material.uniforms.opacity.value = current === 0 && !dim ? intro : 0; });
  const ARRIVE = [0, LEG / 2, LEG, 2 * LEG + STOP, 3 * LEG + 2 * STOP, 4 * LEG + 3 * STOP];
  const showStop = (k, i) => show(k) && (reduce || c >= ARRIVE[i]);
  place(LABELS.warehouse, hubs.find((h) => h.id === "farm").p, showStop("warehouse", 0));
  place(LABELS.trucker, CHAIN[0].curve.getPointAt(0.5), showStop("trucker", 1));
  place(LABELS.ship, hubs.find((h) => h.id === "rio").p, showStop("ship", 2));
  place(LABELS.transit, SEA_STOP, showStop("transit", 3));
  place(LABELS.customs, hubs.find((h) => h.id === "miami").p, showStop("customs", 4));
  place(LABELS.buyer, hubs.find((h) => h.id === "chicago").p, showStop("buyer", 5));
  place(LABELS.shared, lane("rio-miami").mover.position, show("shared"));
  place(LABELS.rio, hubs.find((h) => h.id === "rio").p, show("rio"));
  place(LABELS.miami, hubs.find((h) => h.id === "miami").p, show("miami"));
  place(LABELS.coffee, chainBox.position, show("coffee"));
  place(LABELS.other, lane("rio-miami").mover.position, show("other"));
  const L = LABELS;
  tmp.copy(wp).project(camera);
  const box = { _on: chainBox.visible && boxA > 0.5, _x: (tmp.x * 0.5 + 0.5) * innerWidth - 14, _y: (-tmp.y * 0.5 + 0.5) * innerHeight - 14, _w: 28, _h: 28, style: {} };
  settle([box, L.coffee, L.warehouse, L.ship, L.customs, L.buyer, L.trucker, L.transit, L.other, L.shared, L.rio, L.miami]);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- illustrations: one container of coffee, five companies ----------
const COMPANIES = [["warehouse", "Warehouse"], ["truck", "Trucker"], ["ship", "Ship"], ["stamp", "Customs"], ["building-2", "Buyer"]];
const XS = [8, 29, 50, 71, 92]; // % across the strip
function buildStrip(root, withNotebooks) {
  root.innerHTML = COMPANIES.map(([ic, name], i) =>
    `<div class="node" style="left:${XS[i]}%"><div class="disc">${icon(ic)}</div><b>${name}</b>${withNotebooks ? `<span class="nb2">${icon("notebook-pen")}</span>` : ""}</div>`).join("") +
    XS.slice(1).map((x, i) => `<div class="gapmark" style="left:${(XS[i] + x) / 2}%">${withNotebooks ? icon("circle-help") : `<div class="pens">${icon("pen-line")}${icon("pen-line")}</div>${icon("check-check")}`}</div>`).join("") +
    `<div class="cargo" style="left:${XS[0]}%">${icon("package")}</div>`;
  if (!withNotebooks) root.querySelectorAll(".gapmark").forEach((g) => g.classList.add("sign"));
  return { nodes: [...root.querySelectorAll(".node")], gaps: [...root.querySelectorAll(".gapmark")], cargo: root.querySelector(".cargo") };
}
const arts = Object.fromEntries([1, 2, 4, 5, 8].map((k) => [k, document.querySelector(`[data-art="${k}"]`)]));
const s1 = buildStrip(arts[1].querySelector(".strip"), true);
const s2 = buildStrip(arts[2].querySelector(".strip"), false);
const ledger = arts[2].querySelector(".ledger ol");
ledger.innerHTML = COMPANIES.slice(0, 4).map(([, a], i) => `<li><span>${a} → ${COMPANIES[i + 1][1]}</span><span>signed by both ${icon("check-check")}</span></li>`).join("");
const rows = [...ledger.children];

function tlProblem() {
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8 });
  tl.set(s1.cargo, { left: XS[0] + "%" }).set(s1.gaps, { opacity: 0 });
  XS.slice(1).forEach((x, i) => {
    tl.to(s1.cargo, { left: x + "%", duration: 0.9, ease: "power1.inOut" })
      .to(s1.gaps[i], { opacity: 1, duration: 0.12, repeat: 5, yoyo: true }, "<0.4")
      .set(s1.gaps[i], { opacity: 1 });
  });
  return tl.to({}, { duration: 1.2 });
}
function tlSign() {
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1 });
  const pens = s2.gaps.map((g) => [...g.querySelectorAll(".pens .ico")]), checks = s2.gaps.map((g) => g.querySelector(":scope > .ico"));
  tl.set(s2.cargo, { left: XS[0] + "%" }).set(s2.gaps, { opacity: 0 }).set(rows, { opacity: 0 }).set([...pens.flat(), ...checks], { opacity: 0 })
    .add(() => s2.nodes.forEach((n, i) => n.classList.toggle("on", i === 0)));
  XS.slice(1).forEach((x, i) => {
    const mid = (XS[i] + x) / 2;
    tl.to(s2.cargo, { left: mid + "%", duration: 0.5, ease: "power1.inOut" })
      .set(s2.gaps[i], { opacity: 1 })
      .fromTo(pens[i][0], { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.3 }) // the company handing over signs
      .fromTo(pens[i][1], { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.3 }, "+=0.15") // then the one receiving
      .fromTo(checks[i], { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(3)" }, "+=0.15")
      .to(rows[i], { opacity: 1, duration: 0.3 }, "<")
      .to(s2.cargo, { left: x + "%", duration: 0.4, ease: "power1.inOut" })
      .add(() => s2.nodes[i + 1].classList.add("on"));
  });
  return tl.to({}, { duration: 1.4 });
}

// plug in once: your system -> one adapter -> everyone on the rail
const plug = arts[4].querySelector("svg"), NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs, parent = plug) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.append(e); return e; };
const ico = (name, x, y, s, color) => { const g = el("g", { transform: `translate(${x - s / 2} ${y - s / 2}) scale(${s / 24})`, fill: "none", stroke: color, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }); g.innerHTML = ICONS[name]; return g; };
el("rect", { x: 30, y: 110, width: 110, height: 80, rx: 12, fill: "hsl(210 10% 8%)", stroke: "#303740" });
ico("server", 85, 140, 30, "#A8ABB0");
el("text", { x: 85, y: 178, class: "sm" }).textContent = "Your company";
const cable = el("path", { d: "M140 150 L 240 150", stroke: "#C6F24E", "stroke-width": 3, fill: "none", "stroke-dasharray": 100, "stroke-dashoffset": 100 });
const hubC = el("circle", { cx: 300, cy: 150, r: 38, fill: "hsl(210 10% 8%)", stroke: "#303740", "stroke-width": 2 });
el("text", { x: 300, y: 156 }).textContent = "Radox";
const socket = el("rect", { x: 258, y: 140, width: 9, height: 20, rx: 2, fill: "#0E0F11", stroke: "#303740", "stroke-width": 1.5 });
const plugIcon = el("g", {}), plugShape = ico("plug", 150, 150, 22, "#C6F24E");
plugShape.setAttribute("transform", plugShape.getAttribute("transform") + " rotate(90 12 12)"); // prongs face Radox
plugIcon.append(plugShape);
const flash = el("circle", { cx: 300, cy: 150, r: 38, fill: "none", stroke: "#C6F24E", "stroke-width": 2, opacity: 0 });
const WHO = ["Ports", "Airports", "Carriers", "Customs", "Buyers", "Banks"];
const spokes = WHO.map((w, i) => {
  const y = 40 + i * 44;
  const line = el("line", { x1: 338, y1: 150, x2: 470, y2: y, stroke: "#C6F24E", "stroke-width": 1.5, opacity: 0 });
  const dot = el("circle", { cx: 476, cy: y, r: 6, fill: "#303740" });
  const t = el("text", { x: 492, y: y + 4, class: "sm", "text-anchor": "start" }); t.textContent = w; t.setAttribute("style", "text-anchor:start");
  return { line, dot };
});
function tlPlug() {
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1 });
  tl.set(cable, { attr: { "stroke-dashoffset": 100 } }).set(plugIcon, { x: 0 }).set(hubC, { attr: { stroke: "#303740" } })
    .set(socket, { attr: { stroke: "#303740" } }).set(flash, { opacity: 0, attr: { r: 38 } })
    .set(spokes.map((s) => s.line), { opacity: 0 }).set(spokes.map((s) => s.dot), { attr: { fill: "#303740" } })
    .to(cable, { attr: { "stroke-dashoffset": 0 }, duration: 1, ease: "power2.inOut" })
    .to(plugIcon, { x: 99, duration: 1, ease: "power2.inOut" }, "<")
    .to(socket, { attr: { stroke: "#C6F24E" }, duration: 0.1 })
    .to(hubC, { attr: { stroke: "#C6F24E" }, duration: 0.2 }, "<")
    .fromTo(flash, { opacity: 0.9, attr: { r: 38 } }, { opacity: 0, attr: { r: 60 }, duration: 0.6, ease: "power2.out" }, "<");
  spokes.forEach((s) => tl.to(s.line, { opacity: 0.8, duration: 0.25 }).to(s.dot, { attr: { fill: "#C6F24E" }, duration: 0.2 }, "<"));
  return tl.to({}, { duration: 1.6 });
}

// ---------- ask the API: example first, then a live answer from the public contract ----------
const SHIP = { key: "31b4cff785831659b4ecb8fd3e7382f9760a12ef45ef7eb30f45b3b6911a5e37" };
const ROLE = { // test actors of the live test shipment
  GAJTXDXNNKX7J5WQB3NWJQJM6IJIJSN2EBJE52R24ZXUPYYMYYUDF3K2: "Warehouse", GCRBNBSUMHH2ZZNI64UPEMCAKOLKLNA5PQC6IV5R4ZO43URLJVUXSH4D: "Port",
  GBSRCRAWQNVRLFAMJUATUTOLL5JEXD5X2NW6NNU4O7X3DTOW4KP2BMFE: "Carrier", GA6JTLEGAFOZPHR7TMSU7LAG6WLKN2USBLIYRMRRT6KXDH4AOKAOTIEW: "Customs",
  GAG5WGRM7D2BQWD66FBW4UCU4BADB4UIX7B5QAOOR25JP25E5JDA35P7: "Buyer",
};
const RECORDED = { status: "Delivered", currentCustodian: "Buyer (test actor)", route: "Warehouse → Port → Carrier → Customs → Buyer", seq: "4" };
const REQ = `GET /api/shipments/${SHIP.key.slice(0, 8)}…${SHIP.key.slice(-5)}`;
const apiReq = document.getElementById("api-req"), apiAns = document.getElementById("api-ans"), apiTag = document.getElementById("api-tag");
const apiNote = document.getElementById("api-note"), runBtn = document.getElementById("run");
// scene 6 demo: the visitor signs each handover with both wallets; the coffee moves only after both
const DM = { strip: document.getElementById("d-strip"), step: document.getElementById("d-step"), a: document.getElementById("d-a"), b: document.getElementById("d-b"),
  rec: document.getElementById("d-rec"), read: document.getElementById("d-read"), wallets: document.getElementById("d-wallets"), reset: document.getElementById("d-reset") };
DM.strip.innerHTML = COMPANIES.map(([ic, name]) => `<div class="dn"><div class="disc">${icon(ic)}</div>${name}</div>`).join("") + `<div class="dcargo">${icon("package")}</div>`;
const dNodes = [...DM.strip.querySelectorAll(".dn")], dCargo = DM.strip.querySelector(".dcargo");
let hop = 0, signed = [false, false];
function dRender() {
  dCargo.style.left = hop * 20 + "%";
  dNodes.forEach((n, i) => n.classList.toggle("on", i === hop));
  const done = hop === COMPANIES.length - 1;
  DM.wallets.hidden = done; DM.read.hidden = !done; runBtn.hidden = !done; DM.reset.hidden = !done;
  if (done) { DM.step.textContent = "Delivered. Now read it the way a buyer or insurer would:"; return; }
  const from = COMPANIES[hop][1], to = COMPANIES[hop + 1][1];
  DM.step.textContent = `Handover ${hop + 1} of 4: ${from} gives the coffee to ${to}.` + (signed[0] !== signed[1] ? ` Waiting for ${signed[0] ? to : from} to sign.` : "");
  [[DM.a, from, 0], [DM.b, to, 1]].forEach(([btn, who, k]) => { btn.textContent = signed[k] ? `${who} signed ✓` : `Sign as ${who}`; btn.classList.toggle("done", signed[k]); btn.disabled = signed[k]; });
}
function dSign(k) {
  if (hop >= COMPANIES.length - 1) return;
  signed[k] = true;
  if (signed[0] && signed[1]) {
    DM.rec.insertAdjacentHTML("beforeend", `<li><span>${COMPANIES[hop][1]} → ${COMPANIES[hop + 1][1]}</span><span>practice signatures ${icon("check-check")}</span></li>`);
    hop++; signed = [false, false];
  }
  dRender();
}
DM.a.addEventListener("click", () => dSign(0));
DM.b.addEventListener("click", () => dSign(1));
DM.reset.addEventListener("click", () => { hop = 0; signed = [false, false]; DM.rec.innerHTML = ""; apiReq.textContent = REQ; answer({ status: "Delivered", currentCustodian: "Buyer", route: "Warehouse → Trucker → Ship → Customs → Buyer", seq: "4" }); apiTag.className = "tag"; apiTag.textContent = "Practice run"; apiNote.textContent = "Practice run in your browser. The real contract runs on Stellar's test network."; runBtn.textContent = "Read the real one on Stellar"; dRender(); });
dRender();

function answer(a) {
  const dd = apiAns.querySelectorAll("dd");
  [a.status, a.currentCustodian, a.route, a.seq].forEach((v, i) => { dd[i].textContent = v; });
  if (!reduce) gsap.fromTo(apiAns.children, { opacity: 0, x: 8 }, { opacity: 1, x: 0, duration: 0.3, stagger: 0.12 });
}
async function runLive() {
  runBtn.disabled = true; apiTag.className = "tag"; apiTag.textContent = "Asking…";
  apiReq.textContent = REQ;
  try {
    // the same public endpoint as /docs; it answers "source": "snapshot" when testnet is unreachable
    const t0 = performance.now();
    const res = await fetch(`api/shipments/${SHIP.key}`, { signal: AbortSignal.timeout(8000) });
    const d = await res.json();
    if (!res.ok || d.source !== "live") throw new Error(d.error?.code || "not live");
    const r = d.shipment;
    const name = (g) => ROLE[g] || g.slice(0, 4) + "…" + g.slice(-4);
    answer({ status: [].concat(r.status).join(" "), currentCustodian: `${name(r.current_custodian)} (test actor)`, route: r.route.map(name).join(" → "), seq: String(r.seq) });
    apiTag.className = "tag live"; apiTag.textContent = `Live · Stellar testnet · ${Math.round(performance.now() - t0)} ms`;
    apiNote.textContent = "Live record from the public contract on Stellar's test network. Its test companies use other names.";
  } catch {
    answer(RECORDED);
    apiTag.className = "tag"; apiTag.textContent = "Recorded sample";
    apiNote.textContent = "Could not reach the test network. Showing a recorded sample.";
  } finally { runBtn.disabled = false; runBtn.textContent = "Read it again"; }
}
runBtn.addEventListener("click", runLive);


// ---------- scrolling: the scene most in view drives the globe and its loop ----------
const AUTO = [8000, 8000, 10000, 8000, 7000, 9000, 9000, 9000, 9000]; // ?play only: scrolls by itself, to record the video
const chapters = [...document.querySelectorAll(".ch")];
const dimEl = document.getElementById("dim"), seen = new Set();
let tl = null;

function setScene(n) {
  if (n === current) return;
  current = n;
  sceneStart = performance.now();
  gsap.to(dimEl, { opacity: DIMMED.has(current) ? 1 : 0, duration: reduce ? 0 : 0.5 });
  if (!seen.has(n)) {
    seen.add(n);
    if (!reduce) gsap.fromTo([...chapters[n].querySelector(".copy").children, ...(arts[n] ? [arts[n]] : [])],
      { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, stagger: 0.08, ease: "power3.out" });
  }
  tl?.kill(); tl = null;
  if (current === 1) tl = tlProblem();
  if (current === 2) tl = tlSign();
  if (current === 4) tl = tlPlug();
  if (tl && reduce) tl.progress(0.98).pause();
}
const ratio = new Map();
const io = new IntersectionObserver((entries) => {
  for (const e of entries) ratio.set(e.target, e.intersectionRatio);
  let best = 0, bestR = -1;
  chapters.forEach((c, i) => { const r = ratio.get(c) ?? 0; if (r > bestR) { bestR = r; best = i; } });
  setScene(best);
}, { threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] });
chapters.forEach((c) => io.observe(c));
setScene(0);

if (new URLSearchParams(location.search).has("play") && !reduce) {
  const next = (i) => {
    chapters[i].scrollIntoView({ behavior: "smooth" });
    if (i === 5) [0, 1, 2, 3, 4, 5, 6, 7].forEach((k) => setTimeout(() => dSign(k % 2), 1200 + k * 700));
    if (i === 6) setTimeout(() => document.getElementById("verify").click(), 2500);
    if (i < chapters.length - 1) setTimeout(() => next(i + 1), AUTO[i]);
  };
  next(0);
}
