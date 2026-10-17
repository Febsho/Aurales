# Rust core architecture

Aurales keeps React and TypeScript responsible for rendering, navigation,
presentation, and lightweight UI state. Expensive or backend-like work crosses
coarse Tauri operations into focused modules under `src-tauri/src/core`.

Active coarse operations cover:

- movie, series, and anime-season detail loading;
- addon catalog and authoritative addon-detail metadata loading;
- provider request deduplication, priority, bounded concurrency, timeouts, and
  stale-navigation protection;
- provider metadata normalization and anime title/structure/episode mapping;
- SQLite-backed Fribb anime-ID indexing, best-match resolution, and
  stale-while-revalidate refresh;
- addon stream fan-out and complete-batch stream ranking, including reliability
  and playback-memory inputs;
- authenticated Aurales Sync batch round-trips; and
- the existing SQLite, image, thumbnail, subtitle, platform, and mpv services.

Compatibility wrappers retain the established TypeScript-facing APIs and use
the old browser implementation when native execution is unavailable or fails
before a safe result. Existing cache keys and persisted SQLite/user-data shapes
are unchanged.

## Intentional TypeScript boundaries

- Metadata policy orchestration stays in TypeScript because it directly reads
  Zustand settings and controls progressive React enrichment. Provider detail
  work and normalization behind it are native; moving the policy itself would
  add IPC state duplication without removing meaningful work.
- Stream preload memory stays beside the player lifecycle. Rust performs live
  provider fan-out and ranking; the UI keeps manual selection and cached-player
  state semantics.
- The sync outbox remains in its existing IndexedDB format so queued operations
  survive upgrades unchanged. Rust owns the network batch, while TypeScript
  applies returned records to the current profile stores.
- Auth-specific provider lists and connected watch-state aggregation remain in
  TypeScript. Combining them into a generic native URL proxy would weaken the
  coarse-operation boundary and risk provider-specific semantics.
- The anime web worker remains as the browser/older-binary fallback. Tauri
  production uses the Rust SQLite/in-memory index.

These boundaries are deliberate: migrating them solely to increase the Rust
percentage would add IPC calls or duplicate frontend state without improving
coordination, persistence, or main-thread cost.
