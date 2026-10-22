// Generates the slicer-project fixtures for cia C-05 (helper volumes):
//
//   prusa-helper-volumes.3mf  Producer: PrusaSlicer (prusa-slicer-console
//     --export-3mf). This script writes a seed package by hand (a 20 mm box
//     ModelPart plus a NegativeVolume, a ParameterModifier and a
//     SupportBlocker, 12 triangles each, in one <mesh> as PrusaSlicer stores
//     volumes), then has PrusaSlicer re-save it, so the committed bytes and
//     Metadata/Slic3r_PE_model.config are PrusaSlicer's own.
//   bambu-helper-volumes.3mf  Producer: this script, in the Bambu Studio
//     project layout (root object of components with p:path into
//     3D/Objects/object_1.model, part subtypes in
//     Metadata/model_settings.config), following Bambu Studio's writer
//     (src/libslic3r/Format/bbs_3mf.cpp, commit 79df7ae). Bambu Studio is not
//     installed here, so these bytes are not Bambu-authored.
//
//   node tests/fixtures/make-slicer-helper-volumes.mjs
//
// Needs PrusaSlicer at PRUSA_SLICER or the default install path.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JSZip = createRequire(import.meta.url)('jszip');
const PRUSA = process.env.PRUSA_SLICER ?? 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe';

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
  + '<Default Extension="config" ContentType="application/xml"/></Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

/** Axis-aligned box [lo, hi]^3 as 8 vertices + 12 outward CCW triangles, indices offset by `base`. */
function box(lo, hi, base = 0) {
  const v = [];
  for (const z of [lo, hi]) for (const [x, y] of [[lo, lo], [hi, lo], [hi, hi], [lo, hi]]) v.push([x, y, z]);
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { v, t: t.map(tri => tri.map(i => i + base)) };
}

function meshXml(parts) {
  const verts = parts.flatMap(p => p.v).map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const tris = parts.flatMap(p => p.t).map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
  return `<mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh>`;
}

const VOLUMES = [
  { name: 'box', type: 'ModelPart', lo: 0, hi: 20 },
  { name: 'cavity', type: 'NegativeVolume', lo: 5, hi: 15 },
  { name: 'infill modifier', type: 'ParameterModifier', lo: 1, hi: 4 },
  { name: 'support blocker', type: 'SupportBlocker', lo: 16, hi: 19 },
];

async function prusaSeed() {
  const parts = VOLUMES.map((vol, i) => box(vol.lo, vol.hi, i * 8));
  const model = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" '
    + 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">'
    + `<resources><object id="1" type="model">${meshXml(parts)}</object></resources>`
    + '<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>';
  const volumes = VOLUMES.map((vol, i) => ` <volume firstid="${i * 12}" lastid="${i * 12 + 11}">\n`
    + `  <metadata type="volume" key="name" value="${vol.name}"/>\n`
    + `  <metadata type="volume" key="volume_type" value="${vol.type}"/>\n </volume>\n`).join('');
  const config = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n<object id="1" instances_count="1">\n'
    + ' <metadata type="object" key="name" value="box_with_helpers"/>\n' + volumes + '</object>\n</config>\n';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('3D/3dmodel.model', model);
  zip.file('Metadata/Slic3r_PE_model.config', config);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const BAMBU_PARTS = [
  { id: 1, subtype: 'normal_part', lo: 0, hi: 20 },
  { id: 2, subtype: 'negative_part', lo: 5, hi: 15 },
  { id: 3, subtype: 'modifier_part', lo: 1, hi: 4 },
  { id: 4, subtype: 'support_blocker', lo: 16, hi: 19 },
];

async function bambuProject() {
  const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
    + 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';
  const objects = BAMBU_PARTS.map(p => `<object id="${p.id}" type="model">${meshXml([box(p.lo, p.hi)])}</object>`).join('');
  const sub = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}><resources>${objects}</resources><build/></model>`;
  const comps = BAMBU_PARTS.map(p => `<component p:path="/3D/Objects/object_1.model" objectid="${p.id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('');
  const root = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>`
    + '<metadata name="Application">BambuStudio-01.10.02.76</metadata>'
    + `<resources><object id="5" type="model"><components>${comps}</components></object></resources>`
    + '<build><item objectid="5" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"/></build></model>';
  const parts = BAMBU_PARTS.map(p => `  <part id="${p.id}" subtype="${p.subtype}">\n`
    + `   <metadata key="name" value="${p.subtype}"/>\n  </part>\n`).join('');
  const settings = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="5">\n'
    + '  <metadata key="name" value="box_with_helpers"/>\n' + parts + ' </object>\n</config>\n';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('3D/3dmodel.model', root);
  zip.file('3D/_rels/3dmodel.model.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  zip.file('3D/Objects/object_1.model', sub);
  zip.file('Metadata/model_settings.config', settings);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

if (!existsSync(PRUSA)) throw new Error(`PrusaSlicer not found at ${PRUSA}; set PRUSA_SLICER`);
const work = mkdtempSync(join(tmpdir(), 'mixomesh-helper-volumes-'));
const seed = join(work, 'seed.3mf');
writeFileSync(seed, await prusaSeed());
const prusaOut = join(HERE, 'prusa-helper-volumes.3mf');
const run = spawnSync(PRUSA, ['--export-3mf', '-o', prusaOut, seed], { encoding: 'utf8' });
if (run.status !== 0) throw new Error(`PrusaSlicer export failed: ${run.stderr || run.stdout}`);
const prusaZip = await JSZip.loadAsync(readFileSync(prusaOut));
const prusaConfig = await prusaZip.file('Metadata/Slic3r_PE_model.config').async('text');
for (const vol of VOLUMES) {
  if (!prusaConfig.includes(`value="${vol.type}"`)) throw new Error(`PrusaSlicer dropped the ${vol.type} volume`);
}
console.log(`Wrote ${prusaOut}`);
const bambuOut = join(HERE, 'bambu-helper-volumes.3mf');
writeFileSync(bambuOut, await bambuProject());
console.log(`Wrote ${bambuOut}`);
