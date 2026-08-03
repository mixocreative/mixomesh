const DEFAULT_VIEW = Object.freeze({
  colorSpace: 'srgb',
  invertY: false,
  wrapU: 1,
  wrapV: 1,
  samplingMode: 3,
});

/** Normalize every sampling field MIXOMESH preserves independently of image bytes. */
export function normalizeTextureView(view = {}) {
  return {
    imageContentHash: view.imageContentHash ?? null,
    colorSpace: view.colorSpace === 'linear' ? 'linear' : DEFAULT_VIEW.colorSpace,
    invertY: !!view.invertY,
    wrapU: Number.isInteger(view.wrapU) ? view.wrapU : DEFAULT_VIEW.wrapU,
    wrapV: Number.isInteger(view.wrapV) ? view.wrapV : DEFAULT_VIEW.wrapV,
    samplingMode: Number.isInteger(view.samplingMode) ? view.samplingMode : DEFAULT_VIEW.samplingMode,
  };
}

/** Stable identity for a mutable Babylon texture view over immutable image bytes. */
export function textureViewKey(view) {
  const v = normalizeTextureView(view);
  return JSON.stringify([
    v.imageContentHash,
    v.colorSpace,
    v.invertY,
    v.wrapU,
    v.wrapV,
    v.samplingMode,
  ]);
}

export function textureViewFromBabylon(texture, imageContentHash) {
  return normalizeTextureView({
    imageContentHash,
    colorSpace: texture?.gammaSpace === false ? 'linear' : 'srgb',
    invertY: texture?._invertY ?? false,
    wrapU: texture?.wrapU,
    wrapV: texture?.wrapV,
    samplingMode: texture?.samplingMode ?? texture?.getSamplingMode?.(),
  });
}
