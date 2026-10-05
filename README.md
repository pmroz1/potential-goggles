# Potential Goggles

A desktop-only, performance-oriented video editor (early foundation).

| Layer            | Technology                                   | Location               |
| ---------------- | -------------------------------------------- | ---------------------- |
| UI               | Angular + TypeScript (zoneless, signals)     | `src/`                 |
| Desktop shell    | Tauri 2                                       | `src-tauri/`           |
| Editing core     | Rust (`editor-core` crate)                   | `crates/editor-core/`  |
| Media boundary   | Rust (`media` crate, FFmpeg integration point) | `crates/media/`       |

There is no separate backend service: the Rust core runs inside the Tauri process.

## Prerequisites

- Node.js 22+ and npm
- Rust (stable, 1.90+)
- Platform dependencies for Tauri 2 — see <https://v2.tauri.app/start/prerequisites/>
  (on Debian/Ubuntu: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev`)

## Commands

```sh
npm install

npm run tauri dev            # run the desktop app with live reload
npm run tauri build          # build release binaries + installers

npm test -- --watch=false    # Angular unit tests (Vitest)
npm run build                # production frontend build
cargo test --workspace       # Rust tests (requires a frontend build for src-tauri)
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
```

`npm start` serves the UI in a browser, but the editor needs the Tauri shell
for its backend, so use `npm run tauri dev` for development.

## Core concepts

- **Project** → owns a media pool (`MediaSource`) and any number of **sequences** (timelines).
- **Sequence** → frame rate, resolution and **tracks**.
- **Track** → video or audio, with an explicit `zIndex` that defines compositing order
  (higher is drawn on top) plus blend mode, visibility, mute and lock flags.
- **Clip** → a `SourceRef` (source id + in point), a timeline `start` and `duration`,
  a spatial `transform` and `opacity`. Clips on a track never overlap.
- Time is stored as integer **ticks** (705,600,000 per second, the "flick"), which divides
  evenly into common frame rates (incl. 29.97/59.94) and audio sample rates.

### Edit operations

All project mutations are serializable `EditOp`s (`moveClip`, `setClipTransform`,
`deleteClips`, `pasteClips`, `addSequence`) applied atomically by `Editor`: an operation
either fully succeeds and becomes one undo step, or is rejected and leaves the project untouched.

### Pointer interaction and IPC

Dragging clips on the timeline or layers in the viewport is handled entirely in the UI:

- pointer listeners are attached natively (no Angular change detection per move);
- moves are coalesced to one update per animation frame and applied as a CSS `translate`
  on the dragged element only (with frame snapping and local placement pre-validation);
- **no IPC happens during the drag** — on release a single `moveClip` / `setClipTransform`
  operation is committed to the Rust core, which validates it and returns the new snapshot.

### Clipboard

Copy (`Ctrl/Cmd+C`) builds a structured `ClipboardPayload`
(`application/x-potential-goggles-clips`, versioned) holding complete clip data plus each
clip's time offset from the earliest copied clip and its lane offset in the z-ordered track
stack. Paste (`Ctrl/Cmd+V`) inserts copies with new ids at the playhead, preserving all clip
properties and relative layout. Clips go onto their original tracks, or — when a target track
is selected (click a track header/lane) — relative to that track. Paste is a single undoable
operation.

Other shortcuts: `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` redo, `Delete` removes
selected clips. Click/drag the ruler to move the playhead.

### Media / FFmpeg

`crates/media` defines the `MediaBackend` trait (probe, frame decoding, export). FFmpeg is not
linked yet; the app uses `UnavailableBackend` and the viewport renders placeholder layers. A
future FFmpeg-backed implementation plugs in without changes to the core or UI.
