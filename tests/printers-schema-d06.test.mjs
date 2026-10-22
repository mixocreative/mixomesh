// cia D-06 / C-15 F8: printers.json carries only fields something reads, and a
// printer's default material belongs to the printer's process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { installEnv } from './env.mjs';

installEnv();
const rows = JSON.parse(readFileSync(new URL('../src/config/printers.json', import.meta.url), 'utf8'));
const materials = JSON.parse(readFileSync(new URL('../public/config/materials.json', import.meta.url), 'utf8')).materials;
const { normalizePrinterProfile, listPrinterProfiles } = await import('../src/core/print/PrinterProfiles.js');

const MATERIAL_PROCESS = {
  'uv-inkjet': ['Full-colour'], polyjet: ['Resin', 'Full-colour'], mjf: ['SLS'], sls: ['SLS'],
  fdm: ['FDM', 'Custom'], 'fdm-multi': ['FDM'], resin: ['Resin'],
};

test('printers.json rows hold none of the five fields nothing reads', () => {
  for (const [id, r] of Object.entries(rows)) {
    assert.equal(r.verified, undefined, `${id}: verified`);
    assert.equal(r.colour?.vertexColour, undefined, `${id}: colour.vertexColour`);
    assert.equal(r.export?.formats, undefined, `${id}: export.formats`);
    assert.equal(r.export?.threeMF?.seatOnBed, undefined, `${id}: threeMF.seatOnBed`);
    assert.equal(r.validation?.maxTrianglesHint, undefined, `${id}: validation.maxTrianglesHint`);
  }
});

test('normalised profiles do not invent the dead fields either', () => {
  for (const p of [...listPrinterProfiles(), normalizePrinterProfile('x', {})]) {
    assert.equal('verified' in p, false);
    assert.equal('vertexColour' in p.colour, false);
    assert.equal('formats' in p.export, false);
    assert.equal('seatOnBed' in p.export.threeMF, false);
    assert.equal('maxTrianglesHint' in p.validation, false);
  }
});

test('every printer quotes a material of its own process', () => {
  for (const [id, r] of Object.entries(rows)) {
    const m = materials.find(x => x.id === r.defaultMaterialId);
    assert.ok(m, `${id}: material ${r.defaultMaterialId} exists`);
    assert.ok(MATERIAL_PROCESS[r.process].includes(m.process), `${id} (${r.process}) defaults to ${m.id} (${m.process})`);
  }
});
