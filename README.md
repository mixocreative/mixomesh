# MIXOMESH

Browser-based 3D model assembly tool for full-color 3D printing. MIXOMESH is
 UV inkjet color 3D print-first: textured 3MF Materials Extension and OBJ+MTL+PNG exports preserve
continuous-tone color for UV-inkjet printers, while filament targets use solid
per-part 3MF color groups.

## First-time setup

You need **Node.js 22 or newer** once. Get it from https://nodejs.org (the "LTS"
button). Then, inside this folder, install the project's dependencies:

```bash
npm install
```

That's it — you only do this once (and again whenever dependencies change).

## Run the web version locally

Start the local web server:

```bash
npm run dev
```

Then open **http://127.0.0.1:5173/** in Chrome or Edge. Edits reload live. Press
`Ctrl+C` in the terminal to stop it.

To preview the real production build instead (what visitors get online):

```bash
npm run build
npm run preview
```

Open the **http://127.0.0.1:4173/** address it prints.

## Run the desktop (offline) version

The desktop app is the same tool in its own window, works fully offline, and can
read/write local files. Build once, then launch it:

```bash
npm run build
npm run electron
```

To make a double-clickable Windows installer (`.exe`) for other people, see
[Build the Windows installer](#build-the-windows-installer) below.

## Build the Windows installer

Double-click **`build-installer.cmd`** in the repo root (or run `npm run build:installer -- [flags]`).
It wipes `release/` and `dist/`, warns about uncommitted changes, runs `npm test` (stops on
failure), builds the app, runs electron-builder, and copies only the installer to
**`installers/MIXOMESH-Setup-<version>.exe`** (plus a `.sha256` file; size and hash are
printed). `release/` and `dist/` are wiped again afterwards.

Flags: `--skip-tests` (bypass the test gate) and `--keep-build` (keep `release/` + `dist/`,
needed to run `npm run smoke:packaged`). Exit code 0 = ok; otherwise the failing step is named.

The installer is a wizard: per-user by default (`%LOCALAPPDATA%\Programs\MIXOMESH`, no admin
needed), you can choose another folder, and it uninstalls via Settings > Apps. It registers
the App Paths entry and the `.mixo` file association. cloudflared is not bundled: a
URL-only publish platform downloads it once on first use (pinned, SHA-256 verified).

## Build a clean dist every time

```bash
npm run build
```

`npm run build` always **wipes the `dist/` folder first**, so every build is
clean — no leftover old files. `dist/` is what gets published online and what the
desktop app loads.

## Put it online (GitHub Pages — free hosting)

This repo is already wired to publish itself. One-time steps:

1. Push the project to a GitHub repository (from this folder):

   ```bash
   git push
   ```

2. On GitHub, open the repo → **Settings** → **Pages**. Under
   **"Build and deployment" → Source**, choose **"GitHub Actions"**. Save.

That's all. From now on, **every `git push` rebuilds and republishes the site
automatically** (via `.github/workflows/deploy.yml`). After a minute or two your
app is live at:

```
https://<your-github-username>.github.io/<your-repo-name>/
```

You never edit any paths — the build uses relative links, so it works whatever
your repo is named.

## Verify

```bash
npm run lint
npm run typecheck
npm run i18n:check
npm run build
npm run test
npm run test:browser
npm run test:export
npm run test:repair
npm run test:group
```

`npm run probe:scans [dir]` (not part of `test:all`) runs every model in
`tests/fixtures/real-scans/` (git-ignored — drop your own scans there) through
import → validate → repair → re-validate → 3MF export and prints one row per
file with the manifold/volume verdict; see the header of
`tests/scan-probe.mjs` for the `PROBE_*` switches.

`npm run test:all` chains the test commands listed in the `test:all` script of
`package.json` (currently `test && test:browser && test:export && test:repair && test:group && test:ui-style && test:refinement && test:3mf-orientation && test:settings-toggle`). The browser smokes
stay OUT of `npm test`: they launch a real Chrome/Edge and a Vite server, so
the headless node:test suite must remain runnable without either.

The browser smokes start a temporary Vite server and drive Chrome or Edge
through the DevTools Protocol (`test:browser` covers UI + rendering output
including a real headless turntable mp4; `test:export` is the functional
export round-trip; `test:repair` imports an open (non-watertight) mesh,
repairs it, exports it, and checks the result is actually watertight).
`npm run fixtures` regenerates the two committed `.glb` fixtures those smokes
import (`tests/fixtures/open-tetra.glb`, `tests/fixtures/textured-quad.glb`)
from their generator scripts; `tests/hygiene.test.mjs` fails if a committed
fixture has drifted from its generator.

`npm run test:video` is an OPTIONAL headed check — it opens a small visible
browser window for a full-size turntable recording (`VIDEO_CHECK_EDGE=1`
forces Edge). Add targeted manual Chrome or slicer checks when changing
browser-only file picker flows or external export compatibility.

## Publishing to Cults3D (desktop app)

The desktop app can publish your finished prints directly to Cults3D for sale
— no separate upload step.

**Get an API key.** Visit https://cults3d.com/en/api/keys in your Cults3D
account and generate an API key. Keep it safe; you'll use it once to connect
the app.

**Connect your account.** In MIXOMESH, go to **Print ▸ Publish**. Select
Cults3D, enter your Cults3D nickname and API key, then **Connect**. The key is
stored encrypted on this PC and is only ever sent to Cults3D. **Test
connection** checks it works.

**How the temporary link works.** When you publish, your files are served from
your PC through a short-lived Cloudflare link only while the publish runs.
Nothing is stored anywhere else — the files stay on your machine and the link
is removed as soon as Cults3D has downloaded them (or when MIXOMESH closes).
Keep the app open until the publish finishes and shows your listing's address
(with a Copy button).

**Firewall note.** MIXOMESH needs outbound HTTPS on port 443 (standard internet).
It may also use UDP port 7844 for faster tunneling, but falls back to HTTP/2
over TCP 443 if that's blocked.

**Advanced option: your own S3 or R2 bucket.** If you prefer to use your own
object storage, you can configure it in the Publish tab under **Advanced: my
own S3 / R2 bucket**. Enter your bucket credentials and endpoint; the files
get short-lived links and are deleted once Cults3D has them. This is optional — the temporary link from your PC works
fine for most people.

**Web and mobile.** On the web build and iPad, you can save a listing package
file (`.listbridge.zip`) — a complete offline package you can upload to any
marketplace by hand.

### Packaged-app smoke (desktop build)

`npm run dist` runs `electron-builder` (a declared devDependency). It writes the
installer and `release/win-unpacked/` (cloudflared is no longer bundled; `npm run build:installer -- --keep-build` does this too). To prove the packaged app can publish, run:

```bash
npm run build && npm run dist
npm run smoke:packaged        # = node scripts/packaged-smoke.mjs [path to MIXOMESH.exe]
```

It launches the unpacked `MIXOMESH.exe` with `MIXO_SMOKE=1` (the same security probe as
`npm run test:electron`, run from inside `app.asar`) and passes only if the window boots and
`publish:describe` lists `cults3d` plus the default `tunnel` file host. That also proves the
ESM import of `src/listbridge/index.js` resolves from `app.asar`, the one packaging risk.
Run it once on a clean Windows user profile (the unsigned installer shows SmartScreen; the
unpacked exe does not).

## Automation: call MIXOMESH from another app

The desktop MIXOMESH can be driven programmatically by another application (scripts, shop backends, Blender add-ons) to import, validate, export, and render files without opening the UI. The automation API is available via **named-pipe JSON-RPC** for live sessions or **one-shot job files** for batch conversion.

### Finding the exe

**Via the Windows Registry:**

```cmd
reg query "HKCU\Software\MIXOMESH" /v InstallLocation
```

Or, to launch MIXOMESH from another app:

**PowerShell:**
```powershell
Start-Process MIXOMESH.exe -ArgumentList "--open", "C:\path\to\model.glb", "--library", "C:\parts"
```

**Python:**
```python
import subprocess
subprocess.Popen([
    "MIXOMESH.exe",
    "--open", r"C:\path\to\model.glb",
    "--library", r"C:\parts"
])
```

**C#:**
```csharp
var proc = new ProcessStartInfo("MIXOMESH.exe")
{
    ArgumentList = { "--open", @"C:\path\to\model.glb", "--library", @"C:\parts" },
    UseShellExecute = true
};
Process.Start(proc);
```

### Batch jobs (`--job` / `--result`)

Run a series of automation API calls as a hidden batch, one-shot:

**Command line:**
```cmd
MIXOMESH.exe --job job.json --result result.json --hidden --quit
```

**job.json schema:**
```json
{
  "apiVersion": 1,
  "steps": [
    {
      "method": "scene.import",
      "params": {
        "files": ["C:\\models\\base.glb", "C:\\models\\parts.3mf"]
      }
    },
    {
      "method": "scene.transform",
      "params": {
        "id": "<object id from scene.list>",
        "position_mm": [0, 0, 50],
        "rotation_deg": [0, 0, 45],
        "scale": 1.5
      }
    },
    {
      "method": "validate.run",
      "params": {}
    },
    {
      "method": "export.run",
      "params": {
        "formats": ["3mf", "obj"],
        "outDir": "C:\\output",
        "overwrite": true
      }
    }
  ],
  "stopOnError": true
}
```

**result.json (written by MIXOMESH):**
```json
{
  "apiVersion": 1,
  "ok": true,
  "steps": [
    {
      "method": "scene.import",
      "ok": true,
      "result": {
        "count": 2,
        "ids": ["obj_abc123", "obj_def456"]
      },
      "ms": 1250
    },
    {
      "method": "export.run",
      "ok": true,
      "result": {
        "outDir": "C:\\output",
        "files": [
          {
            "name": "project.3mf",
            "path": "C:\\output\\project.3mf",
            "size": 52480
          },
          {
            "name": "project.obj",
            "path": "C:\\output\\project.obj",
            "size": 28960
          }
        ]
      },
      "ms": 5340
    }
  ]
}
```

**Exit codes:**
- `0` — success, all steps completed
- `2` — a step failed (check `result.json` for which one)
- `3` — invalid job file (bad JSON or missing required fields)
- `4` — job timed out (exceeded 20 minutes or app took too long to start)
- `5` — automation API unavailable (disabled in Preferences or not installed)

**Retrying safely (`requestId`):** any request or job step may carry `"requestId": "<your id>"`
in its `params` (1 to 128 characters). If the same id arrives again within 10 minutes, MIXOMESH
does not run it again: it answers with the first request's result, or waits for the first if it
is still running. Give each step of a job its own stable id, and a job you re-run after a
timeout will not import the same files twice. A request that failed is not remembered, so its
retry runs normally. Reusing an id for a different method is refused with `E_INVALID_PARAMS`.

### Live API via named pipe

For long-running sessions or real-time monitoring, connect to a live MIXOMESH instance over a per-user Windows named pipe.

**Python (≤ 25 lines):**
```python
import json
import os

# Read the session file
user_data = os.path.expandvars(r"%APPDATA%\MIXOMESH\api\session.json")
with open(user_data) as f:
    session = json.load(f)

# Connect and authenticate
pipe = open(session['pipe'], 'r+b', buffering=0)
pipe.write(json.dumps({
    "jsonrpc": "2.0",
    "id": 1,
    "method": "hello",
    "params": {"token": session['token'], "apiVersion": 1}
}).encode() + b'\n')
response = json.loads(pipe.readline())

# Make a request
pipe.write(json.dumps({
    "jsonrpc": "2.0",
    "id": 2,
    "method": "scene.list",
    "params": {"includeValidation": True}
}).encode() + b'\n')
result = json.loads(pipe.readline())
print(result['result'])
```

**Node.js (≤ 25 lines):**
```javascript
const net = require('net');
const fs = require('fs');
const path = require('path');

const sessionFile = path.join(process.env.APPDATA, 'MIXOMESH', 'api', 'session.json');
const {pipe, token} = JSON.parse(fs.readFileSync(sessionFile));

const sock = net.createConnection(pipe);
sock.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'hello',
  params: {token, apiVersion: 1}
}) + '\n');

sock.once('data', hello => {
  sock.write(JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'scene.list',
    params: {includeValidation: true}
  }) + '\n');
  sock.once('data', result => console.log(JSON.parse(result)));
});
```

**C# (≤ 25 lines):**
```csharp
using System;
using System.IO.Pipes;
using System.Text.Json;
using System.IO;

var path = Path.Combine(Environment.GetFolderPath(
    Environment.SpecialFolder.ApplicationData), "MIXOMESH", "api", "session.json");
var json = JsonDocument.Parse(File.ReadAllText(path)).RootElement;
var pipeName = json.GetProperty("pipe").GetString().Replace("\\\\.\\pipe\\", "");
var token = json.GetProperty("token").GetString();

var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
pipe.Connect();
var w = new StreamWriter(pipe) {AutoFlush = true};

w.WriteLine(JsonSerializer.Serialize(new {
  jsonrpc = "2.0", id = 1, method = "hello",
  @params = new {token, apiVersion = 1}
}));

var line = new StreamReader(pipe).ReadLine();
Console.WriteLine(line);
```

### Methods reference

**App info:**
- `app.info` — app version, platform, API version
- `app.capabilities` — supported methods list
- `app.ping` — health check

**Project:**
- `project.new` — new project (clears scene if `confirm:true`)
- `project.open` — load `.mixo` file (needs `confirm:true` if dirty)
- `project.save` — save current project
- `project.saveAs` — save to new `.mixo` path (needs `file` path parameter)
- `project.info` — project name, file path, modified flag

**Scene objects:**
- `scene.list` — list all objects with bounds, triangle counts, validation status
- `scene.get` — retrieve one object's properties
- `scene.import` — add models to the scene (GLB, glTF, 3MF, OBJ, STL supported)
- `scene.remove` — delete objects (needs `confirm:true`)
- `scene.select` — set the selection (optional `additive:true` for union)
- `scene.transform` — move/rotate/scale an object (position in mm, rotation in degrees)

**Library & printer:**
- `library.mount` — mount a folder to the Library tab
- `library.list` — list folder contents
- `printer.list` — list available printer profiles
- `printer.get` — get current printer selection
- `printer.set` — set active printer profile

**Validation, repair & cost:**
- `validate.run` — run watertight/manifold checks
- `repair.run` — auto-fix holes and intersections (needs `confirm:true`)
- `readiness.get` — print readiness report (watertight, manifold, size, etc.)
- `cost.quote` — estimate material volume and cost

**Export & render:**
- `export.run` — export to 3MF, OBJ, STL, PLY, WRL (specify `formats` array and `outDir` path)
- `render.png` — capture viewport as PNG (specify `outFile` path, `width`, `height`)
- `render.thumbnail` — export small listing image as PNG

**Events:**
- `events.subscribe` — subscribe to push notifications (`objectAdded`, `objectRemoved`, `selectionChanged`, `validationDone`, `exportDone`, `projectOpened`, `projectSaved`, `busy`); `projectSaved` fires only when a save wrote the `.mixo`, not when undo or File > New merely make the project clean

### Error codes

| Code | Meaning |
|------|---------|
| `E_INVALID_PARAMS` | Parameter validation failed (missing required field, wrong type, value out of range) |
| `E_METHOD_NOT_FOUND` | Unknown method name |
| `E_NOT_FOUND` | Object ID does not exist (e.g. `scene.get` with invalid id) |
| `E_PATH_REJECTED` | Path is invalid, not accessible, or outside the allowed set (network/device paths, missing parent) |
| `E_BUSY` | Another request is in flight; serialize requests |
| `E_CONFIRM_REQUIRED` | Destructive action needs `confirm: true` in params |
| `E_DIRTY` | Project has unsaved changes; pass `confirm: true` to overwrite |
| `E_CANCELLED` | User cancelled a dialog (happens in visible window only) |
| `E_UNSUPPORTED` | Feature not available on this runtime (e.g. export on the web build) |
| `E_EXPORT_GATE` | Export blocked by validation errors (geometry problems prevent printing) |
| `E_LIMIT` | Too many of something: too many files, frame too large, too many steps, etc. |
| `E_TIMEOUT` | Request took longer than 10 minutes |
| `E_INTERNAL` | Unexpected error; check the message for details |

### Limits

- **4 concurrent clients** per MIXOMESH instance
- **1 request in flight** (requests are serialized; send one, wait for response, send the next)
- **1 MiB per JSON-RPC frame** (split large imports across multiple `scene.import` calls)
- **32 files per `scene.import` call**
- **1 GiB per file** (import file size limit, output file size limit)
- **10 minutes per request** (use jobs for longer batch work)
- **64 steps per job**, 20 minutes total per job
- **50 events per second** (notifications are dropped if you subscribe to too many events at once)

### Security notes

- **Windows user only:** The named pipe is per-user; you must be the same Windows user as the running MIXOMESH.
- **Session token required:** The 32-byte token in `<AppData>\MIXOMESH\api\session.json` authenticates every connection. Never share this file or its contents.
- **Paths are validated:** Import/library/export paths are checked in the main process; the renderer never sees absolute paths.
- **No overwrite by default:** Exporting to an existing file fails unless you pass `overwrite: true`.
- **Destructive operations need consent:** Methods like `project.new`, `scene.remove`, `repair.run` return `E_CONFIRM_REQUIRED` unless you pass `confirm: true`.
- **Disable if needed:** Toggle the automation API on/off in **Preferences**.

### What is NOT available via the API

- Publishing to Cults3D or other marketplaces (v2 or later)
- Localhost HTTP / WebSocket server (security model: named pipe on Windows only)
- Slicing or G-code generation (MIXOMESH exports, the printer's slicer generates paths)

## Dependency Notes

Dependencies are project-local and installed with npm. The helper script forces
`.tmp/` and `.npm-cache/` inside this repo so global temp/cache permissions do
not decide the install.

One-click watertight repair and a live material-cost quote run on vendored,
offline engines in `public/vendor/`: [MeshFixLib](https://github.com/hololocheck/MeshFixLib)
(MIT) fills holes and fixes non-manifold geometry, [Manifold](https://github.com/elalish/manifold)
(Apache-2.0) backs the offline Boolean/CSG path — no runtime CDN, no network
call either engine depends on.

## Status

See `BLUEPRINT.md` for the canonical rebuild spec. Active agent instructions
live in `AGENTS.md`; `CLAUDE.md` is a compatibility pointer for older tools.
