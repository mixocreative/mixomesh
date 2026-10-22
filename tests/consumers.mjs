// Independent-consumer check for every print format the app writes
// (`npm run test:consumers`). Reference models go through the REAL import and
// the REAL export pipeline in headless Chrome (PrintManager.collectExportFiles,
// default options, as the Export panel runs it): 3MF with textures (Materials
// Extension), 3MF colour groups, 3MF in the Bambu flavour, OBJ + MTL + PNG,
// STL, PLY and VRML. Then programs that share no code with MIXOMESH read
// every file:
//
//   - PrusaSlicer `--info` (3MF, STL, OBJ): facets, size, manifold.
//   - python trimesh / pymeshlab via tests/consumers.py: welded watertight,
//     volume, size, colour per face direction, texture colour near each
//     corner (orientation), vertex positions (mirroring), part names.
//
// Every fact is compared with TRUTH below, which is written from the fixture
// sources (glTF and OBJ specs, fixture generator comments), never derived from
// the app. Printer frame: Z up, millimetres; a Y-up source maps
// (x, y, z) -> (x, -z, y), the convention Blender and slicers use.
//
// KNOWN lists defects this check found that are not fixed yet. A matching
// check prints KNOWN and does not fail the run; once the defect is fixed the
// check passes and the run fails until the entry is removed.
//
// A missing consumer fails the run. SKIP_CONSUMERS=1 turns that into an
// UNVERIFIED line instead. CONSUMERS_OUT=<dir> keeps the exported files.
//
//   node tests/consumers.mjs

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchApp, resolveCommand, removeTempDir } from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const READER = join(ROOT, 'tests/consumers.py');
const PRUSA = process.env.PRUSA_SLICER ?? 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe';
const SKIP = process.env.SKIP_CONSUMERS === '1';

const RED = '#FF0000', GREEN = '#00FF00', BLUE = '#0000FF', WHITE = '#FFFFFF';
const CAT_NAME = '猫　モデル';

// quadrant-quad.glb (tests/fixtures/make-quadrant-quad.mjs): one 50 mm quad in
// glTF XY, facing +Z, two triangles, open. Texture image top-left red, top-right
// green, bottom-left blue, bottom-right white; glTF uv (0,0) is the image top-
// left. v0 (0,0,0) uv (0,0) red, v1 (50,0,0) uv (1,0) green, v2 (50,50,0) uv
// (1,1) white, v3 (0,50,0) uv (0,1) blue. In the printer frame the quad lies in
// XZ, so near (min x, min z) the surface is red, (max x, min z) green, (max x,
// max z) white, (min x, max z) blue. A flipped or mirrored texture or a
// mirrored part moves those colours.
//
// open-tetra.glb (make-open-tetra.mjs): v0 (0,0,0) v1 (10,0,0) v2 (0,20,0)
// v3 (0,0,30), three faces, one hole. Export repairs by default, so the file
// must be the closed right tetrahedron, 4 facets, (1/6)*10*20*30 = 1000 mm^3.
// Printer frame: v0 (0,0,0) v1 (10,0,0) v2 (0,0,20) v3 (0,-30,0); relative to
// the bounding-box minimum (0,-30,0): (0,30,0) (10,30,0) (0,30,20) (0,0,0).
//
// cat-model-3mat.obj (+ .mtl), imported as "猫　モデル.obj": a closed Y-up box
// 10 x 20 x 30 mm, 12 triangles, 6000 mm^3. OBJ top (+Y) red, +X green, the
// rest blue; in the printer frame +Z red, +X green, size 10 x 30 x 20.
const TRUTH = {
  quad: {
    facets: 2, watertight: false, size: [50, 0, 50],
    corners: { 'low-low': RED, 'high-low': GREEN, 'high-high': WHITE, 'low-high': BLUE },
  },
  tetra: {
    facets: 4, watertight: true, volume: 1000, size: [10, 30, 20],
    points: [[0, 30, 0], [10, 30, 0], [0, 30, 20], [0, 0, 0]],
  },
  cat: {
    facets: 12, watertight: true, volume: 6000, size: [10, 30, 20],
    faceColours: { '+z': [RED], '+x': [GREEN], '-x': [BLUE], '+y': [BLUE], '-y': [BLUE], '-z': [BLUE] },
    name: CAT_NAME,
  },
};

const MODELS = [
  { key: 'quad', fixture: 'quadrant-quad.glb', formats: ['3mf', 'obj', 'stl', 'ply', 'wrl'] },
  { key: 'tetra', fixture: 'open-tetra.glb', formats: ['3mf', 'stl'] },
  { key: 'cat', fixture: 'cat-model-3mat.obj', siblings: ['cat-model-3mat.mtl'], loadAs: `${CAT_NAME}.obj`,
    formats: ['3mf', 'obj', 'stl', 'ply', 'wrl'] },
  { key: 'cat', variant: 'bambu', fixture: 'cat-model-3mat.obj', siblings: ['cat-model-3mat.mtl'], loadAs: `${CAT_NAME}.obj`,
    flavour: 'bambu', formats: ['3mf'] },
];

// What each format can carry. PLY bakes the texture per vertex, and at the
// quad's corners a repeating texture blends all four quadrants (c04 checks
// PLY texture sampling against the viewport instead). STL has no colour or names.
const CARRIES = {
  '3mf': { colour: true, corners: true, names: true },
  obj: { colour: true, corners: true, names: true, up: 'y' },
  stl: {},
  ply: { colour: true },
  wrl: { colour: true, corners: true, names: true },
};
const PRUSA_READS = new Set(['3mf', 'stl', 'obj']);

const KNOWN = [
  { match: /^quad\.\w+\.(facets|watertight)$|^quad\.\w+\.prusa\.(facets|manifold)$/,
    why: 'export repair closes an open single-sided sheet into a 0 mm^3 double-sided shell (4 facets) that slicers report as manifold' },
  { match: /^cat\.(3mf|obj)\.prusa\.manifold$/,
    why: '3MF colour-group and OBJ write each colour as its own vertex set, so PrusaSlicer reads the closed box as 3 open parts (14 open edges)' },
  { match: /^cat\.3mf\.name$/,
    why: 'the core 3MF colour-group object carries no name attribute (the Bambu flavour does)' },
  { match: /^cat\.wrl\.name$/,
    why: 'VRML DEF names keep ASCII only, so 猫　モデル becomes "_______export"' },
];

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const labelOf = (model) => `${model.key}${model.variant ? `-${model.variant}` : ''}`;

function checksFor(model, format, facts, prusa) {
  const truth = TRUTH[model.key];
  const can = CARRIES[format];
  const checks = [];
  const add = (name, expect, actual, ok) => checks.push({ id: `${labelOf(model)}.${format}.${name}`, expect, actual, ok });
  const size = facts.max.map((v, i) => v - facts.min[i]);

  add('facets', truth.facets, facts.facets, facts.facets === truth.facets);
  add('size', truth.size, size.map(v => +v.toFixed(3)), truth.size.every((v, i) => near(size[i], v, 0.01)));
  add('watertight', truth.watertight, facts.watertight, facts.watertight === truth.watertight);
  if (truth.watertight) {
    add('windingConsistent', true, facts.windingConsistent, facts.windingConsistent === true);
    add('volume', truth.volume, facts.volume, facts.volume != null && near(facts.volume, truth.volume, truth.volume * 1e-4));
  }
  if (truth.points) {
    const has = (p) => (facts.points ?? []).some(q => q.every((c, k) => near(c, p[k], 0.01)));
    add('points', truth.points, facts.points, (facts.points ?? []).length === truth.points.length && truth.points.every(has));
  }
  if (truth.faceColours && can.colour) {
    const same = Object.keys(truth.faceColours).every(k => JSON.stringify(facts.faceColours[k]) === JSON.stringify(truth.faceColours[k]));
    add('faceColours', truth.faceColours, facts.faceColours, same);
  }
  if (truth.corners && can.corners) {
    const same = facts.cornerAxes === 'xz' && Object.keys(truth.corners).every(k => facts.corners?.[k] === truth.corners[k]);
    add('corners', { axes: 'xz', ...truth.corners }, { axes: facts.cornerAxes, ...facts.corners }, same);
  }
  if (truth.name && can.names) {
    // OBJ object names cannot hold whitespace; the ideographic space may become "_".
    const want = format === 'obj' ? truth.name.replace(/\s/gu, '_') : truth.name;
    add('name', want, facts.names, facts.names.some(n => n.includes(want)));
  }
  if (model.variant === 'bambu') {
    const b = facts.bambu;
    const object = b?.objects?.[0];
    const parts = object?.parts ?? [];
    add('bambu.objectName', truth.name, object?.name, object?.name === truth.name);
    const filamentOf = (p) => b.filament_colour[p.extruder - 1]?.toUpperCase();
    add('bambu.partFilament', 'each part on the filament of its own colour',
      parts.map(p => ({ name: p.name, extruder: p.extruder, filament: filamentOf(p), faces: p.colours })),
      parts.length === 3 && parts.every(p => p.colours.length === 1 && filamentOf(p) === p.colours[0]));
  }
  if (prusa) {
    const prusaSize = can.up === 'y' ? [prusa.size[0], prusa.size[2], prusa.size[1]] : prusa.size;
    add('prusa.facets', truth.facets, prusa.facets, prusa.facets === truth.facets);
    add('prusa.size', truth.size, prusaSize.map(v => +v.toFixed(3)), truth.size.every((v, i) => near(prusaSize[i], v, 0.01)));
    // Bambu parts are open by design (one per filament); only the whole is closed.
    if (model.variant !== 'bambu') {
      add('prusa.manifold', truth.watertight ? 'yes' : 'no', prusa.manifold, prusa.manifold === (truth.watertight ? 'yes' : 'no'));
      if (truth.watertight) add('prusa.volume', truth.volume, prusa.volume, near(prusa.volume, truth.volume, truth.volume * 1e-3));
    }
  }
  return checks;
}

// ── consumers ──────────────────────────────────────────────────────────────

function probeConsumers() {
  const missing = [];
  const python = resolveCommand('python') ?? resolveCommand('python3');
  const libs = python && spawnSync(python, ['-I', '-c', 'import trimesh, pymeshlab, PIL, numpy'], { encoding: 'utf8' });
  const pythonOk = !!python && libs.status === 0;
  if (!pythonOk) missing.push(`python with trimesh, pymeshlab, pillow (${python ? libs.stderr.trim().split('\n').pop() : 'python not found'})`);
  const prusa = existsSync(PRUSA) ? PRUSA : null;
  if (!prusa) missing.push(`PrusaSlicer console at ${PRUSA} (set PRUSA_SLICER)`);
  return { python: pythonOk ? python : null, prusa, missing };
}

/** `--info` prints one block per object; facets and volume add up, the size spans all. */
function prusaInfo(path) {
  const r = spawnSync(PRUSA, ['--info', path], { encoding: 'utf8' });
  const blocks = [];
  for (const line of `${r.stdout}`.split(/\r?\n/)) {
    const m = /^(\w+) = +(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'size_x') blocks.push({});
    if (blocks.length) blocks.at(-1)[m[1]] = m[2].trim();
  }
  if (!blocks.length) throw new Error(`PrusaSlicer could not read ${path}:\n${r.stdout}${r.stderr}`);
  const num = (k) => blocks.map(b => Number(b[k]));
  const lo = ['min_x', 'min_y', 'min_z'].map(k => Math.min(...num(k)));
  const hi = ['max_x', 'max_y', 'max_z'].map(k => Math.max(...num(k)));
  return {
    facets: num('number_of_facets').reduce((a, b) => a + b, 0),
    size: hi.map((v, i) => v - lo[i]),
    manifold: blocks.every(b => b.manifold === 'yes') ? 'yes' : 'no',
    volume: num('volume').reduce((a, b) => a + b, 0),
  };
}

// ── export through the app ─────────────────────────────────────────────────

async function exportAll(app, outDir) {
  const { default: JSZip } = await import('jszip');
  const files = [];
  for (const model of MODELS) {
    const res = await app.run(`(async () => {
      try {
        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const { PrintManager } = await import('/src/core/PrintManager.js');
        const st = await import('/src/core/StateManager.js');
        const hm = await import('/src/core/HistoryManager.js');
        const prev = Object.keys(st.getState().scene.objects);
        if (prev.length) hm.push(new hm.DeleteCommand(prev));
        st.setState(s => ({ ...s, print: { ...s.print, threeMFFlavour: ${JSON.stringify(model.flavour ?? 'core')} } }), { silent: true });
        const get = async (f) => new File([await (await fetch('/tests/fixtures/' + f)).blob()], f);
        const siblingFiles = await Promise.all(${JSON.stringify(model.siblings ?? [])}.map(get));
        await AssetLoader.loadFromBlob(await get(${JSON.stringify(model.fixture)}), ${JSON.stringify(model.loadAs ?? model.fixture)}, undefined, { siblingFiles });
        const r = await PrintManager.collectExportFiles(${JSON.stringify(model.formats)}, { acknowledgeWarnings: true });
        if (r.blocked) return { error: 'export blocked: ' + r.code + ' ' + JSON.stringify(r.readinessIssues) };
        const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
        return { files: r.files.map(f => ({ name: f.name, b64: b64(f.bytes) })) };
      } catch (err) { return { error: String(err?.stack ?? err) }; }
    })()`);
    const label = labelOf(model);
    if (res?.error) throw new Error(`${label} export: ${res.error}`);
    if (res.files.length !== model.formats.length) {
      throw new Error(`${label}: expected one file per format ${model.formats.join(',')}, got ${res.files.map(f => f.name).join(', ')}`);
    }
    for (const [i, f] of res.files.entries()) {
      const format = model.formats[i];
      const dir = join(outDir, label, format);
      mkdirSync(dir, { recursive: true });
      const bytes = Buffer.from(f.b64, 'base64');
      let path = join(dir, f.name);
      writeFileSync(path, bytes);
      if (f.name.endsWith('.zip')) {
        const zip = await JSZip.loadAsync(bytes);
        for (const [entry, file] of Object.entries(zip.files)) {
          if (file.dir) continue;
          mkdirSync(join(dir, entry, '..'), { recursive: true });
          writeFileSync(join(dir, entry), await file.async('uint8array'));
        }
        const main = Object.keys(zip.files).find(n => n.endsWith(`.${format}`));
        if (!main) throw new Error(`${label}: ${f.name} has no .${format} inside`);
        path = join(dir, main);
      }
      files.push({ model, format, path });
    }
  }
  return files;
}

function report(results) {
  let failed = 0;
  const show = (v) => JSON.stringify(v);
  const knownHits = new Map();
  for (const c of results) {
    const k = KNOWN.find(e => e.match.test(c.id));
    if (c.ok && !k) continue;
    if (!c.ok && k) {
      if (!knownHits.has(k)) knownHits.set(k, []);
      knownHits.get(k).push(`${c.id}: expected ${show(c.expect)}, read ${show(c.actual)}`);
    } else if (c.ok) {
      failed++;
      console.log(`FAIL ${c.id}: passes now; remove its KNOWN entry ("${k.why}")`);
    } else {
      failed++;
      console.log(`FAIL ${c.id}: expected ${show(c.expect)}, read ${show(c.actual)}`);
    }
  }
  for (const [k, lines] of knownHits) console.log(`KNOWN ${k.why}\n  ${lines.join('\n  ')}`);
  const known = [...knownHits.values()].reduce((n, l) => n + l.length, 0);
  return { failed, known, passed: results.length - failed - known };
}

async function main() {
  const consumers = probeConsumers();
  if (consumers.missing.length && !SKIP) {
    throw new Error(`missing consumer(s), nothing verified:\n  ${consumers.missing.join('\n  ')}\n(SKIP_CONSUMERS=1 reports them as UNVERIFIED instead)`);
  }
  const keep = process.env.CONSUMERS_OUT ? resolve(process.env.CONSUMERS_OUT) : null;
  const outDir = keep ?? join(tmpdir(), `mixomesh-consumers-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  try {
    const app = await launchApp({ prefix: 'mixomesh-consumers-' });
    let files;
    try {
      files = await exportAll(app, outDir);
      if (app.exceptions.length) throw new Error(`page exceptions during export:\n${app.exceptions.join('\n')}`);
    } finally {
      await app.close();
    }

    let facts = [];
    if (consumers.python) {
      const jobs = files.map((f, i) => ({ id: String(i), path: f.path, format: f.format, up: CARRIES[f.format].up ?? 'z', corners: !!CARRIES[f.format].corners }));
      const jobsPath = join(outDir, 'jobs.json');
      writeFileSync(jobsPath, JSON.stringify(jobs));
      const r = spawnSync(consumers.python, ['-I', READER, jobsPath], { encoding: 'utf8', maxBuffer: 64 << 20 });
      if (r.status !== 0) throw new Error(`tests/consumers.py failed:\n${r.stderr}`);
      facts = JSON.parse(r.stdout);
    }

    const results = [];
    let skipped = 0;
    for (const [i, f] of files.entries()) {
      const fact = facts[i];
      const prusa = consumers.prusa && PRUSA_READS.has(f.format) ? prusaInfo(f.path) : null;
      if (!fact || (!prusa && PRUSA_READS.has(f.format))) skipped++;
      if (!fact) continue;
      if (fact.error) {
        results.push({ id: `${labelOf(f.model)}.${f.format}.read`, expect: 'readable', actual: fact.error, ok: false });
        continue;
      }
      results.push(...checksFor(f.model, f.format, fact, prusa));
    }

    const { failed, known, passed } = report(results);
    const summary = `${files.length} files, ${results.length} checks: ${passed} pass, ${known} known defect(s), ${failed} fail`;
    if (consumers.missing.length) {
      console.log(`UNVERIFIED: ${consumers.missing.join('; ')}. ${skipped} file(s) were NOT read by every independent consumer.`);
    }
    if (failed) throw new Error(`consumers: ${summary}`);
    console.log(`${consumers.missing.length ? 'UNVERIFIED' : 'PASS'} consumers: ${summary}`);
  } finally {
    if (!keep) removeTempDir(outDir);
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
