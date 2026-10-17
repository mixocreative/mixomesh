# MIXOMESH Web and PC Build Guide

This guide explains, in plain language, how MIXOMESH can have both a browser
version and a Windows PC version without becoming two separate projects.

## The Big Idea

MIXOMESH has one main app.

The same source code handles the 3D workspace, model import, colors, materials,
validation, printer bed, project files, and export formats. The difference is
how that same app is packaged:

- **Web version:** runs in Chrome or Edge, and in Safari/WebKit through its
  browser-managed project-storage mode.
- **Windows PC version:** runs inside an Electron desktop window.

Electron is like a desktop container for the same web app. The desktop version
loads the built app from the local computer instead of from a website.

## Simple Map

```text
same MIXOMESH code
  |
  +-- browser build
  |     runs in Chrome / Edge, or Safari / WebKit
  |
  +-- Windows desktop build
        runs in Electron
        uses the same built app files
```

## Where Things Live

| Area | Location | Plain-English Meaning |
| --- | --- | --- |
| App entry page | `index.html` | The page that starts MIXOMESH. |
| App startup | `src/app/boot.ts` and `src/app/main.ts` | Starts Babylon.js and launches the app. |
| Shared app logic | `src/core/` | The brain of the app: state, scene, loading, saving, validation, export, repair, printing logic. |
| Shared interface | `src/ui/` | Panels, buttons, toolbars, project UI, print UI, and other visible controls. |
| Shared styles | `src/styles/` | The visual look of the app. |
| Shared config | `src/config/` | Editable data such as printer sizes, swatches, and scale presets. |
| Web build output | `dist/` | The finished browser-ready app after `npm run build`. |
| Desktop wrapper | `electron/` | The Windows desktop shell that opens the built app in an Electron window. |
| Desktop packaging config | `electron-builder.yml` | Instructions for making a Windows installer. |
| Build commands | `package.json` | The list of commands such as `npm run build`, `npm run electron`, and `npm run build:installer`. |

## What Is Shared Between Versions

Both versions use the same:

- 3D viewport and Babylon.js rendering.
- Model import logic.
- Project format (`.mixo`).
- Printer/build-volume presets.
- Color and material handling.
- OBJ, 3MF, and STL export logic.
- UI panels and controls.

That means a feature added to the core app is normally available to both the web
version and the PC version.

## What Is Different Between Versions

The main difference is file access.

In the browser, the app must follow browser rules. Chrome and Edge can use a
linked folder for live file access. Safari and other WebKit browsers use
browser-managed project storage instead, so files are opened and exported with
the normal browser picker or share/download flow.

In the Windows desktop version, Electron can provide stronger local-computer
features. The project uses a `StorageAdapter` layer so the app can ask for
storage in one common way, while the current runtime decides how to do it:

```text
MIXOMESH asks: "open this file" or "save this project"

Browser version:
  use browser file/storage features

Windows desktop version:
  use Electron + local filesystem features
```

This keeps most of the app from caring whether it is running in a browser tab or
inside the PC app.

## First-Time Setup

Install dependencies once:

```bash
node scripts/install-deps.mjs
```

The project requires Node.js 22 or newer.

## Run the Web Version for Development

Use this while working on the app in a browser:

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:5173/
```

This is a local development server. It is not the public internet.

## Build the Web Version

Create the finished web files:

```bash
npm run build
```

Output goes to:

```text
dist/
```

Those files are the browser-ready app. They can be previewed locally with:

```bash
npm run preview
```

Then open the local preview address shown by the command, usually:

```text
http://127.0.0.1:4173/
```

## Run the Windows PC Version Locally

The desktop app loads the built files from `dist/`, so build first:

```bash
npm run build
npm run electron
```

This opens MIXOMESH in its own desktop window.

Important plain-English note: this is still the same app. Electron is just the
desktop wrapper around it.

## Build the Windows Installer

To create a Windows installer:

```bash
build-installer.cmd
```

Or run `npm run build:installer` from a terminal. The final installer goes to:

```text
installers/
```

The packaging config is:

```text
electron-builder.yml
```

For release use, the installer should be tested on a real Windows machine. Code
signing may also be needed later to avoid Windows SmartScreen warnings.

## Do We Build Each Version Separately?

Yes, but not because there are two apps.

There is one codebase and two outputs:

```text
npm run build
  makes the shared built app in dist/

npm run electron
  runs that built app inside the desktop wrapper

npm run build:installer
  packages that built app plus the desktop wrapper into a Windows installer
```

So the browser and PC versions share the same app code, but they are packaged
differently.

## Quick Command Summary

| Goal | Command |
| --- | --- |
| Install dependencies | `node scripts/install-deps.mjs` |
| Run browser development version | `npm run dev` |
| Build browser-ready files | `npm run build` |
| Preview built web app locally | `npm run preview` |
| Run desktop app locally | `npm run build` then `npm run electron` |
| Build Windows installer | `build-installer.cmd` |

## Current Status in One Sentence

MIXOMESH is designed as one shared Vite/Babylon app, with browser support in
Chrome/Edge and Safari/WebKit (using capability-appropriate storage), and a
Windows PC version using Electron to load the same built app from the local
computer.
