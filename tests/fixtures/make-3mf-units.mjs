// Generates tests/fixtures/units-<unit>.3mf for cia C-06 (3MF Core 1.4.0
// §3.4: `unit` applies to "all vertices, locations, or measurements").
// Producer: this script (Node + jszip). Each file holds a 1-unit cube placed
// twice: a build item at the origin, and a build item translated 10 units
// along x that points at a components object whose component adds another
// 2 units along y. Read independently by trimesh 4.8.1 and PrusaSlicer 2.9.3
// (expected numbers in tests/threemf-units-c06.test.mjs).
//
//   node tests/fixtures/make-3mf-units.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JSZip = createRequire(import.meta.url)('jszip');

const CUBE = '<mesh><vertices>'
  + [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    .map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')
  + '</vertices><triangles>'
  + [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')
  + '</triangles></mesh>';

function model(unit) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`
    + `<resources><object id="1" type="model">${CUBE}</object>`
    + '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 2 0"/></components></object></resources>'
    + '<build><item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></build></model>';
}

for (const unit of ['millimeter', 'centimeter', 'inch']) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  zip.file('3D/3dmodel.model', model(unit));
  const out = join(HERE, `units-${unit}.3mf`);
  writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  console.log(`Wrote ${out}`);
}
