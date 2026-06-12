# Player Root-Cause Report

## Current status

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
