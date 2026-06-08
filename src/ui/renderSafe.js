const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export const escapeAttr = escapeHtml;

export function safeImageSrc(value) {
  const src = String(value ?? '');
  return IMAGE_DATA_URL_RE.test(src) ? escapeAttr(src) : '';
}
