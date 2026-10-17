// Run the shared web/Electron 3MF parser against a local file, without a GPU:
// node scripts/probe-3mf-import.mjs /path/to/model.3mf
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import * as BABYLON from '@babylonjs/core';
import { DOMParser } from '../tests/xml-dom.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/probe-3mf-import.mjs model.3mf');
globalThis.window = { BABYLON, removeEventListener() {} };
globalThis.DOMParser = DOMParser;
const { __test } = await import('../src/core/ThreeMFLoader.js');
const data = await fs.readFile(process.argv[2]);
const start = performance.now();
const zip = await __test.openZip(JSZip, data);
const relationships = new DOMParser().parseFromString(await zip.file('_rels/.rels').async('text'), 'application/xml');
const target = [...relationships.getElementsByTagName('Relationship')]
  .find(rel => rel.getAttribute('Type')?.includes('3dmodel'))?.getAttribute('Target')?.replace(/^\//, '') || '3D/3dmodel.model';
const engine = new BABYLON.NullEngine();
try {
  const scene = new BABYLON.Scene(engine);
  const container = await __test.buildContainer(scene, zip, await zip.file(target).async('text'), { modelPath: target });
  console.log(JSON.stringify({
    meshes: container.meshes.length,
    triangles: container.meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices() / 3, 0),
    materials: container.materials.map(material => ({ color: material.diffuseColor.toHexString(), alpha: material.alpha, texture: !!material.diffuseTexture })),
    seconds: (performance.now() - start) / 1000,
    rssMiB: process.memoryUsage().rss / 1024 ** 2,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
  }, null, 2));
} finally { engine.dispose(); }
