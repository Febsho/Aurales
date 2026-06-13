# Aurales

Aurales is a desktop media library and discovery app with provider sync, configurable catalogs, metadata resolution, and native mpv playback.

## Development

```bash
npm install
npm run dev
```

Run the desktop app with:

```bash
npm run tauri dev
```

Build production assets with `npm run build` and the desktop bundle with `npm run tauri build`.

## Compatibility

Aurales keeps the legacy application identifier and storage namespace so existing Orynt installations retain accounts, settings, caches, and watch history after upgrading.
