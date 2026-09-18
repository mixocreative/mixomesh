/**
 * CapLoops — close the boundary loops the repair engine leaves behind.
 *
 * Measured on 12 photogrammetry scans (2026-09-18): after the engine pass,
 * what remained were a handful of LARGE open loops (the unscanned underside
 * of a plate, a pot rim: 300–750 edges) and a few 3-edge loops — the engine
 * declines them whatever `holeAreaMultiplier` / `oversizeMultiplier` say.
 * A slicer would refuse or guess; print-prep tools "flat fill" them. This
 * does the same: every boundary loop is traced and closed with a fan from
 * its centroid (a 3-edge loop gets the one missing triangle). Winding comes
 * from the triangle that owns the boundary edge, so the cap is consistent
 * with the shell. Loops that touch themselves (a vertex with more than two
 * boundary edges) are traced greedily — never left open on purpose.
 *
 * Pure arrays in, pure arrays out; no Babylon.
 */

const CELL = 1e-4;   // matches Weld.WELD_DISTANCE / MeshRepair.posKey (0.1 mm at 1 BU = 1 m)

/**
 * @param {number[][]} V
 * @param {number[][]} T
 * @returns {{V:number[][], T:number[][], capped:number, loops:number, edgesClosed:number}}
 *   `V`/`T` are new arrays (inputs untouched); `capped` = loops closed.
 */
export function capBoundaryLoops(V, T) {
  const outV = V.map(v => [v[0], v[1], v[2]]);
  const outT = T.map(t => [t[0], t[1], t[2]]);
  // Topology by POSITION: vertices in the same 0.1 mm cell are one vertex
  // (a UV seam or an unwelded soup must not read as a boundary).
  const canonOf = new Map();
  const canon = new Int32Array(V.length);
  for (let i = 0; i < V.length; i++) {
    const k = `${Math.round(V[i][0] / CELL)}|${Math.round(V[i][1] / CELL)}|${Math.round(V[i][2] / CELL)}`;
    const c = canonOf.get(k);
    if (c === undefined) { canonOf.set(k, i); canon[i] = i; } else canon[i] = c;
  }
  // Directed boundary edges: an edge a→b used once with no b→a partner.
  const dir = new Map();   // "a>b" → count
  for (const t of T) {
    const a = canon[t[0]], b = canon[t[1]], c = canon[t[2]];
    if (a === b || b === c || c === a) continue;
    for (const [x, y] of [[a, b], [b, c], [c, a]]) dir.set(`${x}>${y}`, (dir.get(`${x}>${y}`) ?? 0) + 1);
  }
  // next[a] = b for every boundary edge traversed a→b by exactly one triangle
  // and no triangle on the other side (b→a absent).
  const next = new Map();   // a → [b, ...]
  for (const [k, n] of dir) {
    if (n !== 1) continue;
    const [a, b] = k.split('>').map(Number);
    if (dir.has(`${b}>${a}`)) continue;
    let list = next.get(a); if (!list) { list = []; next.set(a, list); }
    list.push(b);
  }
  let capped = 0, loops = 0, edgesClosed = 0;
  const used = new Set();   // "a>b" edges consumed
  for (const start of [...next.keys()]) {
    while ((next.get(start) ?? []).some(b => !used.has(`${start}>${b}`))) {
      // Trace one loop greedily.
      const loop = [start];
      let cur = start, closed = false;
      for (let guard = 0; guard < 1_000_000; guard++) {
        const cands = (next.get(cur) ?? []).filter(b => !used.has(`${cur}>${b}`));
        if (!cands.length) break;
        const nxt = cands[0];
        used.add(`${cur}>${nxt}`);
        if (nxt === start) { closed = true; break; }
        loop.push(nxt);
        cur = nxt;
      }
      loops++;
      // An open chain (dead end at a non-manifold vertex) has no inside to
      // cap — leave it; the count still reports it as a loop seen.
      if (!closed || loop.length < 3) continue;
      // The loop runs a→b in the SHELL's winding (each boundary edge is
      // traversed by its owning triangle a→b). The cap must traverse it
      // b→a, so fan triangles are (b, a, centre).
      if (loop.length === 3) {
        outT.push([loop[2], loop[1], loop[0]]);
        capped++; edgesClosed += 3;
        continue;
      }
      let cx = 0, cy = 0, cz = 0;
      for (const i of loop) { cx += V[i][0]; cy += V[i][1]; cz += V[i][2]; }
      const centre = outV.length;
      outV.push([cx / loop.length, cy / loop.length, cz / loop.length]);
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        outT.push([b, a, centre]);
      }
      capped++; edgesClosed += loop.length;
    }
  }
  return { V: outV, T: outT, capped, loops, edgesClosed };
}
