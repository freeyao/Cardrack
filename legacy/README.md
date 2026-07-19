# Legacy — single-file proof of concept

This is the original self-contained `index.html` build of Signal-Collab (v0.3–v0.4),
kept for reference. All logic lived in `src/app.js` and was bundled into one HTML
file. It has been superseded by the `app/` TypeScript workspace at the repo root,
which splits the DOM-free protocol core from the UI and tests it directly in Node.

Contents:
- `index.html` — the built single-file app
- `src/`, `build/` — pre-refactor sources and the esbuild bundle step
- `test/` — the original jsdom-based headless tests
- `serve.ps1`, `serve-https.ps1` — zero-install Windows LAN servers for phone testing

Nothing here is needed to build or run the current app.
