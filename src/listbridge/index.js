export {
  LISTBRIDGE_FORMAT, createListing, validateListing, planBundle, toManifest, fromManifest,
} from './core/package.js';
export { assertAdapter, REQUIRED_ADAPTER_MEMBERS, OPTIONAL_ADAPTER_MEMBERS } from './core/adapter.js';
import { cults3dAdapter } from './adapters/cults3d.js';

export { cults3dAdapter };

/** Registry of built-in platform adapters. A new platform = one file in adapters/ + one entry here. */
export const ADAPTERS = Object.freeze([cults3dAdapter]);
