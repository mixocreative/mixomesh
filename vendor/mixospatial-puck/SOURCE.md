# vendor/mixospatial-puck — the puck's web client, as built

Three files copied verbatim from `mixocreative/mixospatial`, `web/src/`:

| file | what it owns |
|---|---|
| `codec.js` | the wire format of `PROTOCOL.md` — bytes in, values out, and the refusals counted |
| `puck.js` | the link's state machine, bounded reconnection, and the one command (`sleepNow`) |
| `transport-web-bluetooth.js` | `navigator.bluetooth` and nothing else; the transport is injected |

**Source commit:** `7a496e28e1d28cb250b2eaee06b18e1bc4918251` (2026-11-17).

Copied with:

```sh
cp S:/ai/mixospatial/web/src/{codec.js,puck.js,transport-web-bluetooth.js} vendor/mixospatial-puck/
```

## Never edit these here

They are consumed as built, the same rule `vendor/mixo-geocore` works by. A fix belongs in
`mixospatial/web/src`, where the protocol fixtures (`protocol/fixtures/`) test it; then it is
copied down again and the commit above is updated. A change made only here is a change the
fixtures never see, and it would be silently reverted by the next copy.

`mixo-ar` holds its own copy of the same three files for the same reason. **If the protocol
changes, all three places move together** — `mixospatial/PROTOCOL.md` is the contract.

There is no hashing script here, unlike `scripts/vendor-geometry.mjs`: the geometry engine is a
wasm build whose version must match the host's, while these are three small ES modules with no
build step and no version coupling. The commit above is the provenance.

## What mixomesh adds on top

Nothing in these files knows what a turn *means*. That lives in:

- `src/core/puck/orbit.ts` — pure: a reading becomes a camera orbit
- `src/core/puck/PuckLink.js` — the link, the alignment, and driving the camera
- `src/ui/PuckPanel.js` — the control the operator sees

`transport-web-bluetooth.js`'s own header names the one thing it cannot do: Electron needs a
`select-bluetooth-device` handler in the main process. `electron/main.cjs` has it, restricted to
the puck's advertised name — see `electron/WindowSecurity.cjs`.
