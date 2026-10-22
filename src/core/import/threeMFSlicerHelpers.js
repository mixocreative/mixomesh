// Slicer helper volumes (cia C-05): negative volumes, modifiers, support
// blockers/enforcers. They live in the 3MF as ordinary mesh triangles and are
// told apart only by the slicer's own config part, keyed by root object id:
//   PrusaSlicer  Metadata/Slic3r_PE_model.config  <volume firstid lastid> +
//                metadata volume_type (ModelPart = printable; pre-2.2 files:
//                metadata modifier="1")
//   Bambu Studio Metadata/model_settings.config  <part id subtype> where id is
//                the root object's component objectid (or firstid/lastid),
//                normal_part = printable (BambuStudio Model.cpp type_to_string)

import { directChildren } from './threeMFDom.js';

/**
 * @param {import('./threeMFPackage.js').ThreeMFPackage} pkg
 * @returns {Promise<{ ranges: Map<string, number[][]>, components: Map<string, Set<string>>, count: number }>}
 *   `ranges` = helper triangle ranges per root object id, `components` = helper
 *   component object ids per root object id, `count` = helpers found
 */
export async function readSlicerHelpers(pkg) {
  const ranges = new Map();
  const components = new Map();
  let count = 0;
  const readXml = async (path) => {
    try {
      const text = await pkg.partText(path);
      return text == null ? null : new DOMParser().parseFromString(text, 'application/xml');
    } catch { return null; }
  };
  const meta = (el, key) => directChildren(el, 'metadata').find(m => m.getAttribute('key') === key)?.getAttribute('value');
  const addRange = (objectId, el) => {
    const first = parseInt(el.getAttribute('firstid'), 10);
    const last = parseInt(el.getAttribute('lastid'), 10);
    if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) return false;
    if (!ranges.has(objectId)) ranges.set(objectId, []);
    ranges.get(objectId).push([first, last]);
    return true;
  };

  const prusa = await readXml('Metadata/Slic3r_PE_model.config');
  for (const obj of directChildren(prusa?.documentElement, 'object')) {
    for (const vol of directChildren(obj, 'volume')) {
      const type = meta(vol, 'volume_type');
      const helper = type ? type !== 'ModelPart' : meta(vol, 'modifier') === '1';
      if (helper && addRange(obj.getAttribute('id'), vol)) count++;
    }
  }
  const bambu = await readXml('Metadata/model_settings.config');
  for (const obj of directChildren(bambu?.documentElement, 'object')) {
    const objectId = obj.getAttribute('id');
    for (const part of directChildren(obj, 'part')) {
      const subtype = part.getAttribute('subtype');
      if (!subtype || subtype === 'normal_part') continue;
      if (part.hasAttribute('lastid') && parseInt(part.getAttribute('lastid'), 10) > 0) {
        if (addRange(objectId, part)) count++;
        continue;
      }
      if (!components.has(objectId)) components.set(objectId, new Set());
      components.get(objectId).add(part.getAttribute('id'));
      count++;
    }
  }
  return { ranges, components, count };
}
