// <head> boot module: apply the stored interface style as early as a module
// script can run (CSP: script-src 'self', modules only). New users need
// nothing — style-new.css already applies without the attribute.
import { applyStyle, readStyle } from '../core/uiStyleStore.js';

applyStyle(readStyle());
