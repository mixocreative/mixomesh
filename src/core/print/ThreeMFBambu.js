// Bambu Studio / OrcaSlicer 3MF flavour (task 1.11). ThreeMFWriter builds the
// core model (split-by-material ON, one parent `<object><components>` per
// logical object); this module adds what Bambu/Orca read on top of it:
//   - Production extension: `xmlns:p` + `requiredextensions="p"` + `p:UUID`
//     on every <object>, <component>, <build> and <item> (deterministic).
//   - `Metadata/model_settings.config`: one <object> per build object, one
//     <part> per component, `extruder` from a material→slot map.
//   - `Metadata/project_settings.config`: minimal JSON `filament_colour`.
//   - `Metadata/plate_1.png`: the 1.5 thumbnail again (Bambu's plate preview).
// No per-triangle `paint_color` (needs a face-paint tool — deferred, plan 7.1).
// The loader ignores all of it (p:UUID attributes, Metadata/*.config parts).

export const BAMBU_MODEL_SETTINGS_PATH = 'Metadata/model_settings.config';
export const BAMBU_PROJECT_SETTINGS_PATH = 'Metadata/project_settings.config';
export const BAMBU_PLATE_THUMBNAIL_PATH = 'Metadata/plate_1.png';
export const BAMBU_MAX_SLOTS = 4;          // one AMS unit
export const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

const UUID_KIND = { object: '0b1e', component: 'c0a1', build: 'b01d', item: '17e0' };

function _xmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** FNV-1a 32-bit → 8 hex chars. */
function _hash8(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Deterministic RFC-4122-shaped (version 4, variant 8) UUID. The leading
 * counter makes every UUID in one package unique; the seed tail keeps
 * different projects apart.
 */
export function bambuUuid(seed, kind, n) {
  const tail = (_hash8(`${seed}`) + _hash8(`${seed}#${kind}`)).slice(0, 12);
  const k = UUID_KIND[kind] ?? '0000';
  return `${(n >>> 0).toString(16).padStart(8, '0')}-${k}-4${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(0, 6)}${_hash8(kind).slice(0, 6)}`;
}

/**
 * Add the Production extension to a core model XML string produced by
 * ThreeMFWriter. Safe as text rewriting: every attribute value the writer
 * emits is XML-escaped, so `<object ` / `<component ` / `<item ` can only
 * appear as real tags.
 */
export function addProductionExtension(modelXml, seed = 'MIXOMESH') {
  const counters = { object: 0, component: 0, build: 0, item: 0 };
  const next = kind => bambuUuid(seed, kind, ++counters[kind]);
  return modelXml
    .replace(/<model unit="millimeter"/, `<model unit="millimeter" requiredextensions="p"`)
    .replace(/(xmlns="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/core\/2015\/02")/, `$1 xmlns:p="${PRODUCTION_NS}"`)
    .replace(/<object id="(\d+)"/g, (_m, id) => `<object id="${id}" p:UUID="${next('object')}"`)
    .replace(/<component objectid="(\d+)"/g, (_m, id) => `<component objectid="${id}" p:UUID="${next('component')}"`)
    .replace(/<build>/, () => `<build p:UUID="${next('build')}">`)
    .replace(/<item objectid="(\d+)"/g, (_m, id) => `<item objectid="${id}" p:UUID="${next('item')}"`);
}

/** `#RRGGBB[AA]` → `#RRGGBB` (Bambu filament colours are opaque). */
function _rgb(hex) {
  return /^#[0-9a-fA-F]{6}/.test(hex ?? '') ? hex.slice(0, 7).toUpperCase() : '#CCCCCC';
}

/**
 * Material → extruder slot map. First BAMBU_MAX_SLOTS distinct material keys
 * (first-appearance order) → slots 1..4; every further key shares slot 4 and
 * is reported through `onWarning`.
 * @param {{objectId:number,name?:string,parts:{objectId:number,name?:string,key:string,colour:string}[]}[]} objects
 */
export function bambuSlotMap(objects, onWarning) {
  const slotByKey = new Map();
  const colours = [];
  const overflow = [];
  for (const obj of objects) {
    for (const part of obj.parts) {
      if (slotByKey.has(part.key)) continue;
      if (colours.length < BAMBU_MAX_SLOTS) {
        colours.push(_rgb(part.colour));
        slotByKey.set(part.key, colours.length);
      } else {
        slotByKey.set(part.key, BAMBU_MAX_SLOTS);
        overflow.push(part.colour ?? part.key);
      }
    }
  }
  if (overflow.length && typeof onWarning === 'function') {
    onWarning({
      code: '3mf-bambu-slot-overflow',
      message: `Bambu 3MF: ${slotByKey.size} materials but only ${BAMBU_MAX_SLOTS} filament slots — ` +
        `${overflow.length} extra material(s) (${overflow.join(', ')}) share slot ${BAMBU_MAX_SLOTS}. ` +
        'Reassign filaments in the slicer.',
      materials: slotByKey.size,
      slots: BAMBU_MAX_SLOTS,
      overflow,
    });
  }
  return { slotByKey, colours };
}

function _meta(key, value) {
  return `<metadata key="${key}" value="${_xmlAttr(value)}"/>`;
}

/** `Metadata/model_settings.config` (Bambu XML). */
export function buildModelSettings(objects, slotByKey, { plateThumbnail = false } = {}) {
  const objXml = objects.map(obj => {
    const parts = obj.parts.map(part =>
      `  <part id="${part.objectId}" subtype="normal_part">\n` +
      `   ${_meta('name', part.name ?? `part ${part.objectId}`)}\n` +
      `   ${_meta('extruder', slotByKey.get(part.key) ?? 1)}\n` +
      '  </part>\n').join('');
    const firstSlot = obj.parts.length ? (slotByKey.get(obj.parts[0].key) ?? 1) : 1;
    return ` <object id="${obj.objectId}">\n` +
      `  ${_meta('name', obj.name ?? `object ${obj.objectId}`)}\n` +
      `  ${_meta('extruder', firstSlot)}\n` +
      parts +
      ' </object>\n';
  }).join('');
  const instances = objects.map(obj =>
    '  <model_instance>\n' +
    `   ${_meta('object_id', obj.objectId)}\n` +
    `   ${_meta('instance_id', 0)}\n` +
    `   ${_meta('identify_id', obj.objectId)}\n` +
    '  </model_instance>\n').join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + objXml +
    ' <plate>\n' +
    `  ${_meta('plater_id', 1)}\n` +
    `  ${_meta('plater_name', '')}\n` +
    `  ${_meta('locked', 'false')}\n` +
    (plateThumbnail ? `  ${_meta('thumbnail_file', BAMBU_PLATE_THUMBNAIL_PATH)}\n` : '') +
    instances +
    ' </plate>\n</config>\n';
}

/** `Metadata/project_settings.config` — minimal valid JSON. */
export function buildProjectSettings(colours) {
  return JSON.stringify({ filament_colour: colours.length ? colours : ['#CCCCCC'] }, null, 4) + '\n';
}

/** Content types: declare `.config` parts (text) next to the core defaults. */
export function withConfigContentType(contentTypesXml) {
  if (/Extension="config"/.test(contentTypesXml)) return contentTypesXml;
  return contentTypesXml.replace('</Types>', '<Default Extension="config" ContentType="text/plain"/></Types>');
}

/**
 * Turn a core package (entries from ThreeMFWriter, model already split per
 * material) into the Bambu flavour. Mutates nothing; returns new entries.
 * @param {{path:string,data:any}[]} entries
 * @param {{objectId:number,name?:string,parts:{objectId:number,name?:string,key:string,colour:string}[]}[]} objects
 * @param {{seed?:string, thumbnailPng?:any, onWarning?:Function}} [opts]
 */
export function applyBambuFlavour(entries, objects, opts = {}) {
  const thumb = opts.thumbnailPng ?? null;
  const { slotByKey, colours } = bambuSlotMap(objects, opts.onWarning);
  const out = entries.map(e => {
    if (e.path === '3D/3dmodel.model') return { ...e, data: addProductionExtension(e.data, opts.seed) };
    if (e.path === '[Content_Types].xml') return { ...e, data: withConfigContentType(e.data) };
    return e;
  });
  out.push({ path: BAMBU_MODEL_SETTINGS_PATH, data: buildModelSettings(objects, slotByKey, { plateThumbnail: !!thumb }) });
  out.push({ path: BAMBU_PROJECT_SETTINGS_PATH, data: buildProjectSettings(colours) });
  if (thumb) out.push({ path: BAMBU_PLATE_THUMBNAIL_PATH, data: thumb });
  return out;
}
