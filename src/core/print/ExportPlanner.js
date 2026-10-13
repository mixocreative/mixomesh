export function scaleFilenameSuffix(sceneScale, printScale) {
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
