// 3MF import — registers a Babylon SceneLoader plugin for `.3mf`, so every
// existing AssetLoader path (drop, re-instantiate, project restore) handles
// 3MF with zero branching. Babylon ships no 3MF loader (loaders CDN covers
// glTF/OBJ/STL only), so the parser is hand-rolled — and it is the exact
// INVERSE of PrintManager.exportThreeMF: read it back as we wrote it.
//
//   export:  Babylon Y-up mm  --RotationX(-90°)-->  3MF Z-up mm  (+ winding
//            reversed v1,v3,v2, + origin-centred, colour via m:colorgroup OR
//            full texture-uv via m:texture2dgroup + per-tri p1/p2/p3)
//   import:  3MF Z-up mm       --RotationX(+90°)-->  Babylon Y-up mm  (+ winding
//            restored, + colour → StandardMaterial.diffuseColor, OR texture
//            → StandardMaterial.diffuseTexture from the embedded PNG; mm
//            handled by the normal import-scale model exactly like STL —
//            DEFAULT_SOURCE_UNIT is mm)
//
// Scale note: vertices are returned in raw mm and run through the standard
// `bakeImportTransform` (units/ratio) just like an STL — NOT bit-identical to
// the pre-export scene unless workingRatio == targetRatio, which is the same
// inherent ratio-model behaviour as re-importing an exported OBJ/STL.

const BABYLON = window.BABYLON;

const PLUGIN_NAME = '3mf';
const EXT = '.3mf';
// Inverse of PrintManager's Y_UP_TO_Z_UP (= RotationX(-90°)).
const Z_UP_TO_Y_UP = () => BABYLON.Matrix.RotationX(Math.PI / 2);

const NS_MATERIAL = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

let _registered = false;

function _hexToColor3(hex) {
  // Accept #RRGGBB or #RRGGBBAA (export emits 8-digit upper-case).
  const h = String(hex || '').replace(/^#/, '');
  const r = parseInt(h.slice(0, 2) || '80', 16) / 255;
  const g = parseInt(h.slice(2, 4) || '80', 16) / 255;
  const b = parseInt(h.slice(4, 6) || '80', 16) / 255;
  return new BABYLON.Color3(
    Number.isFinite(r) ? r : 0.5,
    Number.isFinite(g) ? g : 0.5,
    Number.isFinite(b) ? b : 0.5,
  );
}

/** Parse a 3MF `<item>`/transform 12-tuple → Babylon row-major Matrix. */
function _itemMatrix(transformStr) {
  if (!transformStr) return null;
  const n = transformStr.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some(x => !Number.isFinite(x))) return null;
  // 3MF: row-major 4×3 (rotation/scale 3×3 then translation row).
  return BABYLON.Matrix.FromValues(
    n[0], n[1], n[2], 0,
    n[3], n[4], n[5], 0,
    n[6], n[7], n[8], 0,
    n[9], n[10], n[11], 1,
  );
}

/** Locate the 3D model part: follow _rels/.rels, fall back to our export path. */
async function _findModelXml(zip) {
  let target = '3D/3dmodel.model';
  const relsFile = zip.file('_rels/.rels');
  if (relsFile) {
    try {
      const relsDoc = new DOMParser().parseFromString(await relsFile.async('text'), 'application/xml');
      for (const rel of relsDoc.getElementsByTagName('Relationship')) {
        const t = rel.getAttribute('Type') || '';
        if (t.includes('3dmodel')) { target = (rel.getAttribute('Target') || target).replace(/^\//, ''); break; }
      }
    } catch { /* malformed rels — use default path */ }
  }
  const modelFile = zip.file(target) || zip.file('3D/3dmodel.model');
  if (!modelFile) throw new Error('3MF: no 3D model part found in package');
  return modelFile.async('text');
}

/**
 * Read a PNG part out of the OPC zip and turn it into a blob URL that a
 * Babylon StandardMaterial.diffuseTexture can be constructed from.
 * Returns null on failure (parser already swallowed everything but path
 * lookups; we don't want a single bad texture to abort the whole load).
 */
async function _texturePartToUrl(zip, partPath) {
  if (!zip || !partPath) return null;
  const clean = partPath.replace(/^\//, '');
  const file = zip.file(clean);
  if (!file) return null;
  try {
    const u8 = await file.async('uint8array');
    return URL.createObjectURL(new Blob([u8], { type: 'image/png' }));
  } catch { return null; }
}

/**
 * Parse the 3MF model XML into Babylon meshes inside an AssetContainer.
 * One mesh per built object; component-only assemblies are skipped (we never
 * export those — one <object>+<mesh> per part).
 *
 * Two material pathways are supported, exactly matching the two writer
 * pipelines in PrintManager._serialize3MF:
 *   m:colorgroup (filament/Bambu)        → mat.diffuseColor
 *   m:texture2dgroup (Mimaki textured)   → mat.diffuseTexture from a PNG
 *                                          part inside the OPC zip
 */
async function _buildContainer(scene, zip, modelXml) {
  const doc = new DOMParser().parseFromString(modelXml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('3MF: malformed 3D model XML');
  }

  // colorgroup id → [Color3,…] (Materials extension; export writes group "1").
  const colorGroups = new Map();
  for (const cg of doc.getElementsByTagNameNS(NS_MATERIAL, 'colorgroup')) {
    const cols = [...cg.getElementsByTagNameNS(NS_MATERIAL, 'color')]
      .map(c => _hexToColor3(c.getAttribute('color')));
    colorGroups.set(cg.getAttribute('id'), cols);
  }

  // texture2d id → { path, url } (resolved blob URLs from the OPC zip).
  const textures = new Map();
  for (const t of doc.getElementsByTagNameNS(NS_MATERIAL, 'texture2d')) {
    const id = t.getAttribute('id');
    const path = t.getAttribute('path') || '';
    const url = await _texturePartToUrl(zip, path);
    textures.set(id, { path, url });
  }

  // texture2dgroup id → { texId, coords[{u,v}, ...] }
  const texGroups = new Map();
  for (const tg of doc.getElementsByTagNameNS(NS_MATERIAL, 'texture2dgroup')) {
    const id = tg.getAttribute('id');
    const texId = tg.getAttribute('texid');
    const coords = [...tg.getElementsByTagNameNS(NS_MATERIAL, 'tex2coord')]
      .map(c => ({
        u: parseFloat(c.getAttribute('u')) || 0,
        v: parseFloat(c.getAttribute('v')) || 0,
      }));
    texGroups.set(id, { texId, coords });
  }

  const objectsById = new Map();
  for (const obj of doc.getElementsByTagName('object')) {
    objectsById.set(obj.getAttribute('id'), obj);
  }

  const container = new BABYLON.AssetContainer(scene);
  const flip = Z_UP_TO_Y_UP();

  // Build placements: prefer <build><item>; if absent, place every meshed
  // object at identity (a model with geometry but no build section).
  const builds = [...doc.getElementsByTagName('item')]
    .map(it => ({ id: it.getAttribute('objectid'), m: _itemMatrix(it.getAttribute('transform')) }));
  const placements = builds.length
    ? builds
    : [...objectsById.keys()].map(id => ({ id, m: null }));

  let made = 0;
  for (const { id, m } of placements) {
    const obj = objectsById.get(id);
    if (!obj) continue;
    const meshEl = obj.getElementsByTagName('mesh')[0];
    if (!meshEl) continue;                       // component-only — skip

    const vEls = meshEl.getElementsByTagName('vertex');
    const tEls = meshEl.getElementsByTagName('triangle');
    if (!vEls.length || !tEls.length) continue;

    const positions = new Array(vEls.length * 3);
    for (let i = 0; i < vEls.length; i++) {
      let p = new BABYLON.Vector3(
        parseFloat(vEls[i].getAttribute('x')) || 0,
        parseFloat(vEls[i].getAttribute('y')) || 0,
        parseFloat(vEls[i].getAttribute('z')) || 0,
      );
      if (m) p = BABYLON.Vector3.TransformCoordinates(p, m);   // 3MF-space item placement
      p = BABYLON.Vector3.TransformCoordinates(p, flip);       // Z-up → Babylon Y-up
      positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
    }

    const pid = obj.getAttribute('pid');
    const tg = pid != null ? texGroups.get(pid) : null;

    const indices = new Array(tEls.length * 3);
    const uvs = tg ? new Array(vEls.length * 2).fill(0) : null;
    for (let i = 0; i < tEls.length; i++) {
      const tEl = tEls[i];
      const a = +tEl.getAttribute('v1');
      const b = +tEl.getAttribute('v2');
      const c = +tEl.getAttribute('v3');
      // Invert the export's winding reversal (it wrote v1,v3,v2): swap back.
      indices[i * 3] = a; indices[i * 3 + 1] = c; indices[i * 3 + 2] = b;

      // Per-triangle UV indices for textured objects. Exporter writes one
      // tex2coord per vertex with p_i == v_i — last-write-wins is harmless
      // because every triangle covering vertex k writes the same coord.
      if (uvs) {
        const p1 = +tEl.getAttribute('p1') || 0;
        const p2 = +tEl.getAttribute('p2') || 0;
        const p3 = +tEl.getAttribute('p3') || 0;
        const co = tg.coords;
        if (co[p1]) { uvs[a * 2] = co[p1].u; uvs[a * 2 + 1] = co[p1].v; }
        if (co[p2]) { uvs[b * 2] = co[p2].u; uvs[b * 2 + 1] = co[p2].v; }
        if (co[p3]) { uvs[c * 2] = co[p3].u; uvs[c * 2 + 1] = co[p3].v; }
      }
    }

    const mesh = new BABYLON.Mesh(obj.getAttribute('name') || `Part_${id}`, scene);
    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices = indices;
    if (uvs) vd.uvs = uvs;
    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    vd.normals = normals;
    vd.applyToMesh(mesh);

    const mat = new BABYLON.StandardMaterial(`${mesh.name}__3mf`, scene);
    if (tg) {
      const tex = textures.get(tg.texId);
      if (tex?.url) {
        const bt = new BABYLON.Texture(tex.url, scene, false, false);
        bt.name = `${mesh.name}__tex`;
        mat.diffuseTexture = bt;
        container.textures?.push?.(bt);
      } else {
        mat.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.8);
      }
    } else {
      const pindex = parseInt(obj.getAttribute('pindex') || '0', 10);
      const group = pid != null ? colorGroups.get(pid) : null;
      mat.diffuseColor = (group && group[pindex]) ? group[pindex] : new BABYLON.Color3(0.8, 0.8, 0.8);
    }
    mat.backFaceCulling = false;
    mesh.material = mat;

    // Hand the entities to the container the way Babylon's own loaders do:
    // detach from the live scene now, AssetLoader calls addAllToScene().
    container.meshes.push(mesh);
    container.materials.push(mat);
    scene.removeMesh(mesh);
    scene.removeMaterial(mat);
    made++;
  }

  if (!made) throw new Error('3MF: no importable mesh objects (component-only assemblies are unsupported)');
  return container;
}

/** Register the `.3mf` SceneLoader plugin exactly once. Idempotent. */
export function registerThreeMFLoader() {
  if (_registered || !BABYLON?.SceneLoader?.RegisterPlugin) return;
  _registered = true;

  const parse = async (scene, data) => {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(data);          // data = ArrayBuffer (isBinary)
    // zip is threaded into _buildContainer so the Materials Extension path
    // can read embedded PNG texture parts directly out of the OPC package.
    return _buildContainer(scene, zip, await _findModelXml(zip));
  };

  BABYLON.SceneLoader.RegisterPlugin({
    name: PLUGIN_NAME,
    extensions: { [EXT]: { isBinary: true } },
    canDirectLoad: () => false,
    // AssetLoader only ever calls LoadAssetContainerAsync → this hook.
    loadAssetContainerAsync(scene, data) {
      return parse(scene, data);
    },
    // Provided for completeness if a path routes through ImportMesh instead.
    async importMeshAsync(_meshNames, scene, data) {
      const c = await parse(scene, data);
      return {
        meshes: c.meshes, particleSystems: [], skeletons: [],
        animationGroups: [], transformNodes: [], geometries: [], lights: [],
      };
    },
    async loadAsync(scene, data) {
      const c = await parse(scene, data);
      c.addAllToScene();
    },
  });
}

registerThreeMFLoader();
