# Player Root-Cause Report

## Final conclusion (2026-07-05)

Exhaustive on-machine bisection (standalone mpv driven over IPC): pause/resume works
perfectly with WASAPI, with the full embedded arg set, with the same codecs
(h264+EAC3 5.1), with hwdec, and even with `--wid` embedding into a foreign
process's window. It fails ONLY inside the app — with every renderer
(gpu-next, gpu, direct3d — direct3d doesn't even display), every AO, every
hwdec mode, with and without the build's bundled Lua scripts. The trigger is
the app's composited architecture itself: a transparent WebView2 overlay as a
sibling of mpv's cross-process child window (repaints over a paused mpv force
frozen-frame redraws; DWM/present interactions wedge mpv's core, taking IPC
down with it). **No mpv option fixes this.**

Interim state (shipped): gpu-next/d3d11 renderer, IPC-ping watchdog (8 s) +
JS auto-restart make every wedge self-heal in a few seconds.
Permanent fix: migrate to in-process libmpv (render API) — no second
process, no pipes, no sibling-window compositing. See the queued task.

## Previous resolution notes (2026-07-04)

Timestamped IPC/command/event logging pinned the freeze chain:

1. **mpv deadlocks at process level when pausing** — after `set_property pause true`, mpv stopped answering IPC pings entirely (`[PLAYER WATCHDOG] mpv unresponsive for 20301ms`). The hang is inside the WASAPI pause path (driver / audio-enhancement hook), not rendering: `--d3d11-flip=no` did not prevent it, and the IPC thread hangs too (core lock held). Mitigation: `--audio-stream-silence=yes` — the audio device is never paused/closed, silence is fed instead.
2. **A hung mpv froze the whole app** because mpv is a cross-process child window (`--wid`): shared input queues block the Tauri UI thread on the next input. Fixed by (a) making `mpv_command`/Discord commands async (off the main thread), (b) `SWP_ASYNCWINDOWPOS` for cross-process `SetWindowPos`, and (c) an IPC-ping **watchdog** that kills a silent mpv after 20 s, detaching the queues so the app recovers on its own.
3. **Restarted sessions were uncontrollable** ("dropped: IPC writer not ready" forever): the dying session's failing writes nulled the *new* session's writer. Fixed by tagging the writer with its session's ipc_path before nulling.
4. Rapid double-launches (React re-running the mount effect) killed the fresh mpv; deduplicated in `launch_embedded_mpv` (same URL within 700 ms is ignored).

Diagnostics kept in place: `[PLAYER ARGS]`, `[MPV CMD]`, `[MPV EVENT]`, `[MPV IPC ERROR]`, reader-disconnect logging, timestamps. JS side auto-restarts the stream when mpv refuses to resume and when playback stalls ≥20 s.

## Original status (historical)

Root cause is not yet proven. The required 10-minute local, direct HTTP, and addon-stream runs must be completed with the new isolated playback mode before a final fix can be claimed.

## Evidence from code inspection

- The full React player owned mpv launch and shutdown in an effect, so component cleanup could kill mpv.
- The full player contained a stall detector that could call `triggerRestart` and recreate mpv.
- The full path continuously observed mpv properties and ran progress, scrobble, subtitle, metadata, and skip-detection work.
- The former Rust launch path forced `gpu-next`, D3D11, decoder direct rendering, reconnect options, custom arguments, and property observation together, which prevented isolating one variable.

## Diagnostic change

- `src/services/player/minimalMpvPlayer.ts` now owns one isolated process session outside React state.
- `src/services/player/playerSessionManager.ts` exposes the singleton isolation session.
- `src-tauri/src/commands.rs` now has a conservative launch path, process/session logging, stderr capture, and no automatic restart.
- `src/components/NativeMpvPlayer.tsx` renders a separate isolated view that bypasses progress, metadata, scrobbling, subtitles, and health loops.
- `src/pages/SettingsPage.tsx` provides local-file and direct-HTTP isolation tests plus log copy/clear controls.
- Automatic stall recovery is disabled during this diagnostic phase.

## Required conclusion test

1. Run the local file test for 10 minutes with `auto-safe`, then `no` hardware decoding.
2. Run the direct HTTP test for 10 minutes in both modes.
3. Run the problematic addon stream and copy Player Logs.
4. Confirm whether `[PLAYER START]` appears once and whether `[PLAYER EXIT]` occurs during a freeze.

Interpretation:

- Repeated starts/exits prove a lifecycle caller or process failure.
- One living process with decoder/hwdec stderr points to GPU decoding or output.
- One living process with HTTP/cache/403/timeout stderr points to the stream or network.
- Stable isolation with broken full playback proves the fault is in the full integration path.
