/**
 * Listbridge adapter contract. Adapters are pure payload builders and result
 * parsers; the host-side runner owns secrets and transport.
 *
 * @typedef {import('./package.js').ListingPackage} ListingPackage
 * @typedef {import('./package.js').Issue} Issue
 *
 * @typedef {object} AdapterDescription
 * @property {string} id
 * @property {string} label
 * @property {'url'|'direct'} transfer 'url' = platform downloads from public links; 'direct' = bytes uploaded.
 * @property {number} maxFiles
 * @property {number} maxImages
 * @property {string[]} [currencies]
 * @property {string[]} fields Listing fields the platform uses.
 *
 * @typedef {object} RequestSpec Transport-neutral request description.
 * @property {string} method
 * @property {string} url
 * @property {Record<string,string>} [headers]
 * @property {any} [body]
 *
 * @typedef {object} PublishResult
 * @property {string} remoteId
 * @property {string} url
 * @property {string} status
 *
 * @typedef {object} Adapter
 * @property {() => AdapterDescription} describe
 * @property {(pkg: ListingPackage) => Issue[]} validate
 * @property {(pkg: ListingPackage, ctx: any) => RequestSpec} buildCreate
 *   Build the create request. ctx carries injected data (e.g. hosted file/image URLs).
 * @property {(remoteId: string, pkg: ListingPackage, ctx: any) => RequestSpec} buildUpdate
 * @property {(response: any) => PublishResult} parseResult
 *   Parse a transport response into a PublishResult; throw on platform errors.
 * @property {(ctx?: any) => RequestSpec} [listCategories] optional request builder
 * @property {(ctx?: any) => RequestSpec} [testConnection] optional request builder
 */

export const REQUIRED_ADAPTER_MEMBERS = ['describe', 'validate', 'buildCreate', 'buildUpdate', 'parseResult'];

/**
 * Throw an Error listing every missing required member.
 * @param {any} obj
 * @returns {Adapter}
 */
export function assertAdapter(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Listbridge adapter must be an object.');
  const missing = REQUIRED_ADAPTER_MEMBERS.filter((m) => typeof obj[m] !== 'function');
  if (obj.listCategories !== undefined && typeof obj.listCategories !== 'function') missing.push('listCategories');
  if (missing.length) throw new Error(`Listbridge adapter is missing or invalid: ${missing.join(', ')}`);
  return obj;
}
