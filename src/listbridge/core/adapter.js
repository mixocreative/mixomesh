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
 * @property {string[]} [credentials] Credential record fields the account form collects
 *   (e.g. ['nickname', 'apiKey']); the runner accepts exactly these (all required).
 *
 * @typedef {object} RequestSpec Transport-neutral request description.
 * @property {string} method
 * @property {string} url
 * @property {Record<string,string>} [headers]
 * @property {any} [body]
 *
 * @typedef {object} BuildContext What the runner hands buildCreate / buildUpdate.
 * @property {Array<{ name: string, mime: string, bytes: Uint8Array, url?: string }>} files
 *   Files to deliver AFTER bundling (an over-limit set arrives as one zip). `url` is set
 *   (short-lived public link) when describe().transfer === 'url'.
 * @property {Array<{ name: string, mime: string, role: string, bytes: Uint8Array, url?: string }>} images
 *
 * @typedef {object} TransportResponse
 * @property {number} status
 * @property {boolean} ok
 * @property {Record<string,string>} headers lower-case names
 * @property {any} json parsed body or null
 * @property {string} text
 *
 * @typedef {object} PublishResult
 * @property {string} remoteId
 * @property {string} url
 * @property {string} status
 *
 * @typedef {object} Adapter
 * @property {() => AdapterDescription} describe
 * @property {(pkg: ListingPackage) => Issue[]} validate
 * @property {(pkg: ListingPackage, ctx: BuildContext) => RequestSpec} buildCreate
 *   Build the create request (no secrets: the runner adds authHeaders()).
 * @property {(remoteId: string, pkg: ListingPackage, ctx: BuildContext) => RequestSpec} buildUpdate
 * @property {(response: TransportResponse) => PublishResult} parseResult
 *   Parse a transport response into a PublishResult; throw on platform errors.
 * @property {(credentialRecord: Record<string, any>) => Record<string,string>} [authHeaders]
 *   Turn the decrypted account record into request headers (e.g. Basic auth). Called by
 *   the host-side runner only; the result is never logged or returned.
 * @property {(result: PublishResult) => RequestSpec} [buildConfirm]
 *   Optional: request that checks the platform has ingested the hosted files. Without
 *   it the runner treats a successful create/update as confirmed.
 * @property {(response: TransportResponse) => { confirmed: boolean, status?: string, url?: string }} [parseConfirm]
 *   Required when buildConfirm is present.
 * @property {(ctx?: any) => RequestSpec} [listCategories] optional request builder
 * @property {(ctx?: any) => RequestSpec} [testConnection] optional request builder
 */

export const REQUIRED_ADAPTER_MEMBERS = ['describe', 'validate', 'buildCreate', 'buildUpdate', 'parseResult'];
export const OPTIONAL_ADAPTER_MEMBERS = ['authHeaders', 'buildConfirm', 'parseConfirm', 'listCategories', 'testConnection'];

/**
 * Throw an Error listing every missing required member (and any optional member
 * that is present but not a function; buildConfirm needs parseConfirm).
 * @param {any} obj
 * @returns {Adapter}
 */
export function assertAdapter(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Listbridge adapter must be an object.');
  const missing = REQUIRED_ADAPTER_MEMBERS.filter((m) => typeof obj[m] !== 'function');
  for (const m of OPTIONAL_ADAPTER_MEMBERS) {
    if (obj[m] !== undefined && typeof obj[m] !== 'function') missing.push(m);
  }
  if (typeof obj.buildConfirm === 'function' && typeof obj.parseConfirm !== 'function') missing.push('parseConfirm');
  if (missing.length) throw new Error(`Listbridge adapter is missing or invalid: ${missing.join(', ')}`);
  return obj;
}
