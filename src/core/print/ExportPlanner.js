// Filename scale token (BLUEPRINT §12, Decision 27). Ratio targets and
// "as shown" keep `_r{ref}to{T}`; a factor target writes `_x{N}`; a height
// target writes `_h{N}mm`. `printScale.target` is the typed print size (absent
// or ratio-kind ⇒ the ratio token).
export function scaleFilenameSuffix(sceneScale, printScale) {
  const target = printScale?.target;
  if (target?.kind === 'factor') return `_x${_ratioToken(target.value)}`;
  if (target?.kind === 'height') return `_h${_ratioToken(target.mm)}mm`;
  return `_r${_ratioToken(sceneScale?.sceneRatio)}to${_ratioToken(printScale?.printRatio)}`;
}

export function exportBaseName(projectName, sceneScale, printScale) {
  return `${safeFilenameStem(projectName || 'Untitled')}${scaleFilenameSuffix(sceneScale, printScale)}`;
}

export function perMeshBaseName(projectName, meshName, sceneScale, printScale) {
  return `${safeFilenameStem(projectName || 'Untitled')}_${safeFilenameStem(meshName || 'Part')}${scaleFilenameSuffix(sceneScale, printScale)}`;
}

export function safeFilenameStem(value) {
  const cleaned = String(value ?? '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return cleaned || 'Untitled';
}

function _ratioToken(ratio) {
  const value = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6))).replace('.', 'p');
}
