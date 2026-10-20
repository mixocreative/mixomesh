"""Exercise a real Mixo GLB's manual refinement controls in Chromium."""

import base64
import json
import struct
from pathlib import Path
from tempfile import gettempdir

from playwright.sync_api import sync_playwright


def sample_glb():
    positions = struct.pack("<12f", 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)
    indices = struct.pack("<12H", 0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3)
    binary = positions + indices
    document = {
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(positions)},
            {"buffer": 0, "byteOffset": len(positions), "byteLength": len(indices)},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3"},
            {"bufferView": 1, "componentType": 5123, "count": 12, "type": "SCALAR"},
        ],
        "meshes": [{"primitives": [{
            "attributes": {"POSITION": 0}, "indices": 1,
            "extras": {"mixo_print_refinement": {
                "version": 1, "creaseByVertex": [0, 0, 0, 0], "sharpEdges": [[0, 1, 1]],
            }},
        }]}],
        "nodes": [{"mesh": 0, "name": "Mixo tetrahedron", "extras": {
            "mixo_origin": "mixo3d", "mixo_marker_version": 1,
            "mixo_viewport_subdiv_level": 1, "mixo_render_subdiv_level": 2,
        }}],
        "scenes": [{"nodes": [0]}], "scene": 0,
    }
    json_bytes = json.dumps(document, separators=(",", ":")).encode()
    json_bytes += b" " * (-len(json_bytes) % 4)
    body = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    body += struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 950})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:5174/index.html")
    page.wait_for_load_state("networkidle")
    page.locator("#boot-status").wait_for(state="detached", timeout=30000)
    encoded = base64.b64encode(sample_glb()).decode()
    ids = page.evaluate("""async encoded => {
      const { AssetLoader } = await import('/src/core/AssetLoader.js');
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      return AssetLoader.loadFromBlob(new Blob([bytes], { type: 'model/gltf-binary' }), 'mixo-tetra.glb');
    }""", encoded)
    assert ids, "import returned no scene object"
    section = page.locator(".mixo-refine-section")
    section.wait_for()
    assert "Mixo 3D" in section.inner_text()
    assert "Off — original GLB" in section.inner_text()
    assert not section.locator("progress").count(), "import started subdivision automatically"
    section.locator('[data-action="refine-level"][data-level="1"]').click()
    section.locator('[data-action="refine-build"]').click()
    page.wait_for_function("""() => {
      const text = document.querySelector('.mixo-refine-section')?.textContent ?? '';
      return text.includes('Ready') || text.includes('failed');
    }""", timeout=30000)
    assert "Ready" in section.inner_text(), section.inner_text()
    section.locator('[data-action="refine-preview"][data-preview="refined"]').click()
    assert "Temporary refined preview" in section.inner_text()
    screenshot = Path(gettempdir()) / "mixomesh-refinement-ui.png"
    page.screenshot(path=str(screenshot))
    selected = page.evaluate("""async sourceId => {
      const { getState } = await import('/src/core/StateManager.js');
      const { collectPrintUnits, buildExportContext } = await import('/src/core/print/ExportContext.js');
      const { AssetLoader } = await import('/src/core/AssetLoader.js');
      const state = getState();
      const ctx = buildExportContext({ state, units: collectPrintUnits(state, false) });
      return { representation: ctx.units[0].representation,
        level: ctx.units[0].parts[0].mesh.metadata?.level ?? null,
        refinedVisible: ctx.units[0].parts[0].mesh.isVisible,
        sourceVisible: AssetLoader.getBabylonMesh(sourceId).isVisible };
    }""", ids[0])
    assert selected == {"representation": "refined", "level": 1,
                        "refinedVisible": True, "sourceVisible": False}, selected
    section.locator('[data-action="refine-preview"][data-preview="original"]').click()
    original = page.evaluate("""async sourceId => {
      const { getState } = await import('/src/core/StateManager.js');
      const { collectPrintUnits, buildExportContext } = await import('/src/core/print/ExportContext.js');
      const { AssetLoader } = await import('/src/core/AssetLoader.js');
      const state = getState();
      return { representation: buildExportContext({ state, units: collectPrintUnits(state, false) }).units[0].representation,
        sourceVisible: AssetLoader.getBabylonMesh(sourceId).isVisible };
    }""", ids[0])
    assert original == {"representation": "original", "sourceVisible": True}, original
    assert not errors, errors
    print(f"PASS browser refinement smoke — import, manual build, both export representations ({screenshot})")
    browser.close()
