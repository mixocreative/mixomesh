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
 * @property {'url'|'direct'} transfer 'url' = platform downloads from public links (needs a file host);
 *   'direct' = bytes are uploaded to the platform itself. With buildUploadSlot present, 'direct'
 *   means "upload slots": the runner asks the platform for a slot per file / image, POSTs the bytes
 *   to it, and hands the resulting keys to buildCreate in ctx.files[].key / ctx.images[].key.
 * @property {Array<'url'|'direct'>} [transfers] Every delivery mode the builders support, preferred first
 *   (e.g. ['direct','url']: buildCreate takes keys when present, else hosted urls).
 * @property {string[]} [visibility] Listing visibilities the platform offers, e.g. ['public','secret'].
 * @property {boolean} [drafts] true when the platform can hold a listing short of public. Note: Cults3D
 *   "secret" is "only people with the link", not a true draft; the UI words it that way.
 * @property {string[]} [requires] Listing fields validate() insists on (e.g. ['categoryHint','license']).
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
 * @property {Array<{ name: string, mime: string, bytes: Uint8Array, url?: string, key?: string }>} files
 *   Files to deliver AFTER bundling (an over-limit set arrives as one zip). `url` is set
 *   (short-lived public link) when the runner used a file host; `key` is set (the platform's
 *   upload key) when it used upload slots.
 * @property {Array<{ name: string, mime: string, role: string, bytes: Uint8Array, url?: string, key?: string }>} images
 * @property {boolean} [update] true when the job updates an existing listing (no files are re-sent).
 *
 * @typedef {object} UploadSlot A presigned multipart POST (S3 style).
 * @property {string} url
 * @property {Array<{ name: string, value: string }>} fields Sent in order, BEFORE the file part.
 * @property {string} key The object key the platform will know the upload by.
 *
 * @typedef {object} ListOptions
 * @property {Array<{ id: string, name: string, children: Array<{ id: string, name: string }> }>} categories
 * @property {Array<{ code: string, name: string, free: boolean, priced: boolean, commercial: boolean }>} licenses
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
 * @property {string} [slug] Platform slug when the read-back needs it (Cults3D creation(slug)).
 *
 * @typedef {object} Adapter
 * @property {() => AdapterDescription} describe
 * @property {(pkg: ListingPackage) => Issue[]} validate
 * @property {(pkg: ListingPackage, ctx: BuildContext) => RequestSpec} buildCreate
 *   Build the create request (no secrets: the runner adds authHeaders()).
 * @property {(remoteId: string, pkg: ListingPackage, ctx: BuildContext) => RequestSpec} buildUpdate
 * @property {(response: TransportResponse) => PublishResult} parseResult
 *   Parse a transport response into a PublishResult; throw on platform errors. Throw with
 *   `code: 'platform-unclear'` when the answer proves neither success nor rejection (unreadable
 *   body, no listing and no error): the runner then treats the create as possibly made.
 * @property {(credentialRecord: Record<string, any>) => Record<string,string>} [authHeaders]
 *   Turn the decrypted account record into request headers (e.g. Basic auth). Called by
 *   the host-side runner only; the result is never logged or returned.
 * @property {(result: PublishResult, ctx?: BuildContext) => RequestSpec} [buildConfirm]
 *   Optional: request that checks the platform has ingested the files. Without
 *   it the runner treats a successful create/update as confirmed. `ctx` is the same
 *   BuildContext the create used (so the adapter knows how many files / images were sent).
 * @property {(response: TransportResponse, ctx?: BuildContext) => { confirmed: boolean, status?: string, url?: string }} [parseConfirm]
 *   Required when buildConfirm is present.
 * @property {(kind: 'file'|'image', item: { name: string, mime: string }) => RequestSpec} [buildUploadSlot]
 *   Optional (upload-slot platforms): request one upload slot. Required together with parseUploadSlot.
 * @property {(response: TransportResponse, item?: { name: string, mime: string }) => UploadSlot} [parseUploadSlot]
 *   Parse a slot response; throws an Error with `code: 'upload-slot-failed'` (+ `issues`) on platform errors.
 *   `item` lets the adapter substitute the file name into the key.
 * @property {(opts?: { locale?: string }) => RequestSpec[]} [buildListOptions]
 *   Optional: request(s) that load the platform's category and license lists. Required with parseListOptions.
 * @property {(responses: TransportResponse[]) => ListOptions} [parseListOptions]
 * @property {(opts?: { locale?: string }) => RequestSpec} [buildOwnListings]
 *   Optional: request the account's own listings, newest included. The runner snapshots them
 *   before a create and, after a create whose answer was lost, looks for the one listing that
 *   is new and carries the title it sent. Required with parseOwnListings.
 * @property {(response: TransportResponse) => Array<PublishResult & { name: string }>} [parseOwnListings]
 *   Throws when the platform did not return a list.
 * @property {(ctx?: any) => RequestSpec} [listCategories] optional request builder
 * @property {(ctx?: any) => RequestSpec} [testConnection] optional request builder
 */

export const REQUIRED_ADAPTER_MEMBERS = ['describe', 'validate', 'buildCreate', 'buildUpdate', 'parseResult'];
export const OPTIONAL_ADAPTER_MEMBERS = [
  'authHeaders', 'buildConfirm', 'parseConfirm', 'listCategories', 'testConnection',
  'buildUploadSlot', 'parseUploadSlot', 'buildListOptions', 'parseListOptions',
  'buildOwnListings', 'parseOwnListings',
];

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
  if (typeof obj.buildUploadSlot === 'function' && typeof obj.parseUploadSlot !== 'function') missing.push('parseUploadSlot');
  if (typeof obj.buildListOptions === 'function' && typeof obj.parseListOptions !== 'function') missing.push('parseListOptions');
  if (typeof obj.buildOwnListings === 'function' && typeof obj.parseOwnListings !== 'function') missing.push('parseOwnListings');
  if (missing.length) throw new Error(`Listbridge adapter is missing or invalid: ${missing.join(', ')}`);
  return obj;
}
