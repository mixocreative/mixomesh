// Edge-detection probe (2026-10-29, owner question). Baseline on engine 9: sharp box 19 edge
// points along its long bottom edges, bevelled boxes (16/32 segments) 0 -> P5.14 regression test.
// Run: node scripts/probes/edge-probe.mjs
// Probe: does generic placement see false edges on split (unwelded) meshes, and does it lose
// ridge reinforcement when a sharp crease is rounded over many facets?
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const dir = new URL('../../public/vendor/mixo-geometry/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const glue = await import(pathToFileURL(dir + 'mixo_geometry_wasm.js').href);
glue.initSync({ module: readFileSync(dir + 'mixo_geometry_wasm_bg.wasm') });
const SOURCES = ['interior', 'boundary', 'ridge', 'island'];

// Settings order: overhang, spacing, edgeInset, sharpEdgeAngle, islands, downward, reinforce
const settings = Float64Array.of(50, 2, 0.45, 45, 1, 1, 1);

function place(name, positions, indices) {
  const s = new glue.GeometrySession(1 << 26);
  try {
    const r = s.generic_place(s.load_mesh(new Float32Array(positions), new Uint32Array(indices)), settings);
    const src = r.take_sources();
    const counts = {};
    for (const k of src) counts[SOURCES[k]] = (counts[SOURCES[k]] ?? 0) + 1;
    r.free();
    console.log(name.padEnd(34), JSON.stringify(counts));
  } finally { s.free(); }
}

// Split triangle soup -> welded by position.
function weld(pos, idx) {
  const map = new Map(); const out = []; const remap = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const key = `${pos[i*3].toFixed(5)},${pos[i*3+1].toFixed(5)},${pos[i*3+2].toFixed(5)}`;
    if (!map.has(key)) { map.set(key, out.length / 3); out.push(pos[i*3], pos[i*3+1], pos[i*3+2]); }
    remap[i] = map.get(key);
  }
  return [out, idx.map(i => remap[i])];
}

// Extrude a convex profile (x,y; Y up) along Z, outward winding, each face with its OWN
// vertices (like a textured mesh split at every face's UV seam).
function extrudeSplit(profile, depth) {
  const pos = []; const idx = [];
  const quad = (a, b, c, d) => { const o = pos.length / 3; pos.push(...a, ...b, ...c, ...d); idx.push(o, o+1, o+2, o, o+2, o+3); };
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = profile[i]; const [x1, y1] = profile[(i + 1) % n];
    quad([x0, y0, 0], [x1, y1, 0], [x1, y1, depth], [x0, y0, depth]);
  }
  for (const [z, flip] of [[0, false], [depth, true]]) {
    const o = pos.length / 3;
    for (const [x, y] of profile) pos.push(x, y, z);
    for (let i = 1; i < n - 1; i++) idx.push(...(flip ? [o, o+i, o+i+1] : [o, o+i+1, o+i]));
  }
  // Make winding outward: positive signed volume.
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t+1], idx[t+2]].map(k => pos.slice(k*3, k*3+3));
    v += a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0]);
  }
  if (v < 0) for (let t = 0; t < idx.length; t += 3) [idx[t+1], idx[t+2]] = [idx[t+2], idx[t+1]];
  return [pos, idx];
}

const box = [[-5, 0], [5, 0], [5, 10], [-5, 10]].reverse();
const vSharp = [[-10, 10], [-10, 2], [0, -6], [10, 2], [10, 10]].reverse();
// Same V, apex rounded by an arc of 8 segments (radius 3) tangent to both slopes.
function vRounded(segments, r) {
  const a = [-10, 2], apex = [0, -6], b = [10, 2];
  const ang = Math.atan2(8, 10); // slope angle below horizontal
  const half = Math.PI / 2 - ang; // half the apex opening
  const d = r / Math.tan(half); // tangent length from apex
  const len = Math.hypot(10, 8);
  const t1 = [apex[0] - 10 / len * d, apex[1] + 8 / len * d];
  const c = [0, apex[1] + r / Math.sin(half)];
  const s0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
  const s1 = Math.PI - s0 + 2 * Math.PI * 0; // mirrored end
  const arc = [];
  for (let k = 0; k <= segments; k++) {
    const t = s0 + (Math.atan2(t1[1] - c[1], -(t1[0] - c[0])) - s0) * k / segments;
    arc.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  void s1; void a; void b;
  return [[-10, 10], [-10, 2], ...arc, [10, 2], [10, 10]].reverse();
}

// Box 10 wide, bottom corners bevelled by an arc (radius r, n segments): the two long bottom edges
// (along Z) are high-poly bevels; the cap edges stay sharp.
function bevelBox(r, n) {
  const pts = [[-5, 10]];
  for (const [cx, start] of [[-5 + r, Math.PI], [5 - r, 1.5 * Math.PI]]) {
    for (let k = 0; k <= n; k++) { const t = start + (Math.PI / 2) * k / n; pts.push([cx + r * Math.cos(t), r + r * Math.sin(t)]); }
  }
  pts.push([5, 10]);
  return pts.reverse();
}
// Count anchors that sit along the long bevelled edges (|x| > 2.5, away from the caps).
function placeDetail(name, positions, indices) {
  const s = new glue.GeometrySession(1 << 26);
  try {
    const r = s.generic_place(s.load_mesh(new Float32Array(positions), new Uint32Array(indices)), settings);
    const src = r.take_sources(); const pos = r.take_positions();
    const counts = {}; let alongBevel = 0;
    for (let k = 0; k < src.length; k++) {
      counts[SOURCES[src[k]]] = (counts[SOURCES[src[k]]] ?? 0) + 1;
      const [x, , z] = [pos[k*3], pos[k*3+1], pos[k*3+2]];
      if (Math.abs(x) > 2.5 && z > 2 && z < 18 && src[k] !== 0) alongBevel++;
    }
    r.free();
    console.log(name.padEnd(40), JSON.stringify(counts), 'edge points along long bottom edges:', alongBevel);
  } finally { s.free(); }
}
for (const [name, prof] of [['box sharp', box], ['box bevel r1 16 seg', bevelBox(1, 16)], ['box bevel r2 32 seg', bevelBox(2, 32)]]) {
  const [sp, si] = extrudeSplit(prof, 20);
  const [wp, wi] = weld(sp, si);
  placeDetail(`${name} welded`, wp, wi);
}


// Rounded crease and split-seam cases (baseline engine 9: V sharp welded ridge 9, V rounded ridge 0;
// split meshes turn every seam inside an overhang into a false boundary).
for (const [name, prof] of [['V sharp', vSharp], ['V rounded 8 seg r3', vRounded(8, 3)]]) {
  const [sp, si] = extrudeSplit(prof, 20);
  const [wp, wi] = weld(sp, si);
  place(`${name} welded`, wp, wi);
  place(`${name} split per face`, sp, si);
}
