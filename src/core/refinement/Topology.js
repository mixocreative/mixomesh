// Pure Loop subdivision over welded topology; render corners remain separate.
// Face/corner adjacency uses JS objects until the final typed arrays exist.
// Keep the default below a browser-tab memory cliff; callers may request a
// larger budget only after providing their own memory policy.
const DEFAULT_MAX_OUTPUT_TRIANGLES = 250_000;
const DEFAULT_MAX_INPUT_VERTICES = 1_000_000;
const WEIGHT_VIEW = new DataView(new ArrayBuffer(4));

function weightFromBits(bits) { WEIGHT_VIEW.setUint32(0, bits, true); return WEIGHT_VIEW.getFloat32(0, true); }
function edgeKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function mix(a, b, weight) { return a.map((v, i) => v * (1 - weight) + b[i] * weight); }
function midpoint(a, b) { return a.map((v, i) => (v + b[i]) * 0.5); }
function add(a, b) { return a.map((v, i) => v + b[i]); }
function scale(a, n) { return a.map(v => v * n); }

function validateInput(input, level, options) {
  const { positions, indices, uvs, normals, creaseByVertex, sharpEdges } = input ?? {};
  if (!(positions instanceof Float32Array) || positions.length === 0 || positions.length % 3) throw new Error('refinement positions are empty or malformed');
  if (!(indices instanceof Uint32Array) || indices.length === 0 || indices.length % 3) throw new Error('refinement indices are empty or malformed');
  if (![0, 1, 2].includes(level)) throw new Error('refinement level must be 0, 1, or 2');
  const vertexCount = positions.length / 3;
  if (vertexCount > (options.maxInputVertices ?? DEFAULT_MAX_INPUT_VERTICES)
    || indices.length / 3 * 4 ** level > (options.maxOutputTriangles ?? DEFAULT_MAX_OUTPUT_TRIANGLES)) throw new Error('refinement size limit exceeded');
  if (uvs != null && (!(uvs instanceof Float32Array) || uvs.length !== vertexCount * 2)) throw new Error('refinement UV array is malformed');
  if (normals != null && (!(normals instanceof Float32Array) || normals.length !== positions.length)) throw new Error('refinement normal array is malformed');
  if (creaseByVertex != null && (!(creaseByVertex instanceof Float32Array) || creaseByVertex.length !== vertexCount)) throw new Error('refinement crease array is malformed');
  if (sharpEdges != null && (!(sharpEdges instanceof Uint32Array) || sharpEdges.length % 3)) throw new Error('refinement sharp edge array is malformed');
  for (const array of [positions, uvs, normals, creaseByVertex]) if (array) for (const value of array) if (!Number.isFinite(value)) throw new Error('refinement attributes must be finite');
  for (const index of indices) if (index >= vertexCount) throw new Error('refinement index out of range');
  if (creaseByVertex) for (const value of creaseByVertex) if (value < 0 || value > 1) throw new Error('refinement crease weight out of range');
  if (sharpEdges) for (let i = 0; i < sharpEdges.length; i += 3) {
    const weight = weightFromBits(sharpEdges[i + 2]);
    if (sharpEdges[i] >= vertexCount || sharpEdges[i + 1] >= vertexCount || sharpEdges[i] === sharpEdges[i + 1]
      || !Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('refinement sharp edge row is malformed');
  }
}

function weld(positions, indices) {
  const ids = new Uint32Array(positions.length / 3);
  const points = [];
  const lookup = new Map();
  ids.fill(0xffffffff);
  for (const i of indices) {
    if (ids[i] !== 0xffffffff) continue;
    const p = Array.from(positions.subarray(i * 3, i * 3 + 3));
    const key = p.map(v => Object.is(v, -0) ? 0 : v).join(',');
    let id = lookup.get(key);
    if (id === undefined) { id = points.length; lookup.set(key, id); points.push(p); }
    ids[i] = id;
  }
  return { ids, points };
}

function adjacency(faces, count) {
  const edges = new Map();
  const neighbors = Array.from({ length: count }, () => new Set());
  const faceLinks = Array.from({ length: count }, () => []);
  const faceNeighbors = [];
  faces.forEach((face, faceId) => {
    const [a, b, c] = face;
    if (a === b || b === c || c === a) throw new Error('refinement has a degenerate welded triangle');
    for (const [u, v, opposite] of [[a,b,c], [b,c,a], [c,a,b]]) {
      const key = edgeKey(u, v);
      const edge = edges.get(key) ?? { a: Math.min(u,v), b: Math.max(u,v), opposite: [], directions: [] };
      edge.opposite.push(opposite); edge.directions.push(u < v ? 1 : -1);
      (edge.faces ??= []).push(faceId);
      if (edge.opposite.length > 2 || (edge.opposite.length === 2 && edge.directions[0] === edge.directions[1])) throw new Error('refinement has a non-manifold edge');
      edges.set(key, edge);
      neighbors[u].add(v); neighbors[v].add(u);
    }
    for (const v of face) faceLinks[v].push(faceId);
  });
  for (const edge of edges.values()) if (edge.faces.length === 2) {
    const [a, b] = edge.faces;
    (faceNeighbors[a] ??= []).push(b);
    (faceNeighbors[b] ??= []).push(a);
  }
  // A manifold vertex has one connected incident face fan (open or closed).
  for (let v = 0; v < count; v++) {
    const incident = faceLinks[v];
    if (incident.length < 2) continue;
    const local = new Set(incident);
    const seen = new Set([incident[0]]); const queue = [incident[0]];
    for (const id of queue) for (const next of faceNeighbors[id] ?? []) if (local.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
    if (seen.size !== incident.length) throw new Error('refinement has a non-manifold vertex');
  }
  return { edges, neighbors };
}

function outputGeometry(points, faces, faceAttrs, hasUvs, hasNormals) {
  const positions = [];
  const uvs = [];
  const normals = [];
  const indices = [];
  const renderMap = new Map();
  let topoNormals = null;
  if (!hasNormals) {
    topoNormals = points.map(() => [0, 0, 0]);
    for (const [a,b,c] of faces) {
      const ab = points[b].map((x,i) => x - points[a][i]);
      const ac = points[c].map((x,i) => x - points[a][i]);
      const n = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
      for (const id of [a,b,c]) topoNormals[id] = add(topoNormals[id], n);
    }
  }
  const unit = n => { const length = Math.hypot(...n); return length ? n.map(v => v / length) : [0,0,1]; };
  faces.forEach((face, fi) => face.forEach((id, corner) => {
    const attr = faceAttrs[fi][corner];
    const normal = unit(hasNormals ? attr.normal : topoNormals[id]);
    const key = `${id}|${hasUvs ? attr.uv.join(',') : ''}|${hasNormals ? attr.normal.join(',') : ''}`;
    let renderId = renderMap.get(key);
    if (renderId === undefined) {
      renderId = positions.length / 3; renderMap.set(key, renderId);
      positions.push(...points[id]); normals.push(...normal);
      if (hasUvs) uvs.push(...attr.uv);
    }
    indices.push(renderId);
  }));
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), normals: Float32Array.from(normals), ...(hasUvs ? { uvs: Float32Array.from(uvs) } : {}) };
}

/** Subdivide a triangle mesh by Loop rules, preserving render-corner UV and normal splits. */
export function refineTopology(input, level, options = {}) {
  validateInput(input, level, options);
  if (level === 0) return {
    positions: input.positions.slice(), indices: input.indices.slice(),
    ...(input.uvs ? { uvs: input.uvs.slice() } : {}),
    ...(input.normals ? { normals: input.normals.slice() } : {}),
  };
  const { ids, points: originalPoints } = weld(input.positions, input.indices);
  let points = originalPoints;
  let faces = [];
  let faceAttrs = [];
  const hasUvs = !!input.uvs;
  const hasNormals = !!input.normals;
  for (let i = 0; i < input.indices.length; i += 3) {
    const render = Array.from(input.indices.subarray(i, i + 3));
    faces.push(render.map(id => ids[id]));
    faceAttrs.push(render.map(id => ({
      uv: hasUvs ? Array.from(input.uvs.subarray(id * 2, id * 2 + 2)) : null,
      normal: hasNormals ? Array.from(input.normals.subarray(id * 3, id * 3 + 3)) : null,
    })));
  }
  const vertexWeights = new Float32Array(points.length);
  if (input.creaseByVertex) for (let i = 0; i < ids.length; i++) if (ids[i] !== 0xffffffff) vertexWeights[ids[i]] = Math.max(vertexWeights[ids[i]], input.creaseByVertex[i]);
  let sharp = new Map();
  if (input.sharpEdges) for (let i = 0; i < input.sharpEdges.length; i += 3) {
    const a = ids[input.sharpEdges[i]], b = ids[input.sharpEdges[i + 1]];
    if (a === 0xffffffff || b === 0xffffffff) continue;
    if (a === b) throw new Error('refinement sharp edge collapses under weld');
    const key = edgeKey(a,b);
    const weight = Math.max(weightFromBits(input.sharpEdges[i + 2]), Math.min(vertexWeights[a], vertexWeights[b]));
    sharp.set(key, Math.max(sharp.get(key) ?? 0, weight));
  }
  for (let step = 0; step < level; step++) {
    options.checkAbort?.();
    options.onProgress?.({ phase: 'Reading topology', completed: step, total: level });
    const { edges, neighbors } = adjacency(faces, points.length);
    if (neighbors.some(set => set.size === 0)) throw new Error('refinement has isolated vertices');
    for (const key of sharp.keys()) if (!edges.has(key)) throw new Error('refinement sharp edge is not in mesh topology');
    const boundary = points.map(() => []);
    const crease = points.map(() => []);
    for (const [key, edge] of edges) {
      const weight = edge.opposite.length === 1 ? 1 : (sharp.get(key) ?? 0);
      if (edge.opposite.length === 1) { boundary[edge.a].push(edge.b); boundary[edge.b].push(edge.a); }
      if (weight > 0) { crease[edge.a].push([edge.b, weight]); crease[edge.b].push([edge.a, weight]); }
    }
    const newPoints = points.map((p, id) => {
      if (boundary[id].length) {
        if (boundary[id].length !== 2) throw new Error('refinement has a non-manifold boundary vertex');
        return add(scale(p, 0.75), scale(add(points[boundary[id][0]], points[boundary[id][1]]), 0.125));
      }
      const n = neighbors[id].size;
      const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
      const smooth = add(scale(p, 1 - n * beta), scale([...neighbors[id]].reduce((sum, other) => add(sum, points[other]), [0,0,0]), beta));
      const ranked = crease[id].sort((a,b) => b[1] - a[1]);
      if (ranked.length < 2) return smooth;
      const hard = ranked.length > 2 ? p : add(scale(p, 0.75), scale(add(points[ranked[0][0]], points[ranked[1][0]]), 0.125));
      return mix(smooth, hard, ranked.length > 2 ? ranked[2][1] : Math.min(ranked[0][1], ranked[1][1]));
    });
    const edgeIds = new Map();
    const nextSharp = new Map();
    for (const [key, edge] of edges) {
      const { a, b, opposite } = edge;
      const creasePoint = midpoint(points[a], points[b]);
      const smoothPoint = opposite.length === 2
        ? add(scale(add(points[a], points[b]), 3/8), scale(add(points[opposite[0]], points[opposite[1]]), 1/8))
        : creasePoint;
      const weight = opposite.length === 1 ? 1 : (sharp.get(key) ?? 0);
      const newId = newPoints.length;
      newPoints.push(mix(smoothPoint, creasePoint, weight)); edgeIds.set(key, newId);
      if (weight > 0 && opposite.length === 2) { nextSharp.set(edgeKey(a,newId), weight); nextSharp.set(edgeKey(newId,b), weight); }
    }
    const nextFaces = []; const nextAttrs = [];
    faces.forEach(([a,b,c], fi) => {
      const [A,B,C] = faceAttrs[fi];
      const ab = edgeIds.get(edgeKey(a,b)), bc = edgeIds.get(edgeKey(b,c)), ca = edgeIds.get(edgeKey(c,a));
      const blendAttr = (x,y) => ({ uv: hasUvs ? midpoint(x.uv,y.uv) : null, normal: hasNormals ? midpoint(x.normal,y.normal) : null });
      const AB = blendAttr(A,B), BC = blendAttr(B,C), CA = blendAttr(C,A);
      nextFaces.push([a,ab,ca], [b,bc,ab], [c,ca,bc], [ab,bc,ca]);
      nextAttrs.push([A,AB,CA], [B,BC,AB], [C,CA,BC], [AB,BC,CA]);
    });
    points = newPoints; faces = nextFaces; faceAttrs = nextAttrs; sharp = nextSharp;
    options.onProgress?.({ phase: 'Refining', completed: step + 1, total: level });
  }
  options.checkAbort?.();
  return outputGeometry(points, faces, faceAttrs, hasUvs, hasNormals);
}

/** Refine material parts as one surface, then return one single-material result per part. */
export function refineTopologyParts(parts, level, options = {}) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('refinement material parts are empty');
  for (const part of parts) validateInput(part, level, options);
  if (parts.length === 1) return [refineTopology(parts[0], level, options)];
  const hasUvs = !!parts[0].uvs;
  const hasNormals = !!parts[0].normals;
  if (parts.some(part => !!part.uvs !== hasUvs || !!part.normals !== hasNormals)) throw new Error('refinement material parts have inconsistent render attributes');
  const totalVertices = parts.reduce((n, part) => n + part.positions.length / 3, 0);
  const totalIndices = parts.reduce((n, part) => n + part.indices.length, 0);
  if (totalVertices > (options.maxInputVertices ?? DEFAULT_MAX_INPUT_VERTICES)
    || totalIndices / 3 * 4 ** level > (options.maxOutputTriangles ?? DEFAULT_MAX_OUTPUT_TRIANGLES)) throw new Error('refinement size limit exceeded');
  const merged = { positions: new Float32Array(totalVertices * 3), indices: new Uint32Array(totalIndices) };
  if (hasUvs) merged.uvs = new Float32Array(totalVertices * 2);
  if (hasNormals) merged.normals = new Float32Array(totalVertices * 3);
  if (parts.some(part => part.creaseByVertex)) merged.creaseByVertex = new Float32Array(totalVertices);
  const edgeRows = [];
  let vertexOffset = 0, indexOffset = 0;
  for (const part of parts) {
    merged.positions.set(part.positions, vertexOffset * 3);
    if (hasUvs) merged.uvs.set(part.uvs, vertexOffset * 2);
    if (hasNormals) merged.normals.set(part.normals, vertexOffset * 3);
    if (part.creaseByVertex) merged.creaseByVertex.set(part.creaseByVertex, vertexOffset);
    for (let i = 0; i < part.indices.length; i++) merged.indices[indexOffset + i] = part.indices[i] + vertexOffset;
    for (let i = 0; i < (part.sharpEdges?.length ?? 0); i += 3) edgeRows.push(part.sharpEdges[i] + vertexOffset, part.sharpEdges[i+1] + vertexOffset, part.sharpEdges[i+2]);
    vertexOffset += part.positions.length / 3; indexOffset += part.indices.length;
  }
  if (edgeRows.length) merged.sharpEdges = Uint32Array.from(edgeRows);
  const result = refineTopology(merged, level, options);
  let triangleOffset = 0;
  return parts.map(part => {
    const triangleCount = part.indices.length / 3 * 4 ** level;
    const slice = result.indices.subarray(triangleOffset * 3, (triangleOffset + triangleCount) * 3);
    triangleOffset += triangleCount;
    const oldToNew = new Map();
    const positions = [], normals = [], uvs = [], indices = [];
    for (const oldId of slice) {
      let id = oldToNew.get(oldId);
      if (id === undefined) {
        id = positions.length / 3; oldToNew.set(oldId, id);
        positions.push(...result.positions.subarray(oldId * 3, oldId * 3 + 3));
        normals.push(...result.normals.subarray(oldId * 3, oldId * 3 + 3));
        if (hasUvs) uvs.push(...result.uvs.subarray(oldId * 2, oldId * 2 + 2));
      }
      indices.push(id);
    }
    return { positions: Float32Array.from(positions), normals: Float32Array.from(normals),
      indices: Uint32Array.from(indices), ...(hasUvs ? { uvs: Float32Array.from(uvs) } : {}) };
  });
}
