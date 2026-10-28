# Native player playback fixes

Changes are limited to the Windows/Linux embedded player and its startup work.

- Linux rendering no longer takes the command/event mutex. Previously the event
  thread spent most of its idle time holding that mutex, causing render callbacks
  to skip frames. Synchronous commands could also starve rendering until timeout.
- mpv's update callback marks pending work atomically. GTK's display frame clock
  queues rendering, replacing the fixed 16 ms redraw timer. Rendering does not
  sleep for mpv's audio-clock deadline on the GTK/WebKit UI thread.
- Removed unconditional EWA chroma/luma scaling, two-pass debanding, linear
  downscaling and compute-shader HDR peak detection. Hardware decode remains
  enabled; Linux retains auto-copy for driver compatibility.
- HDR10/HLG keep their decoder-provided color metadata and bit depth. mpv maps
  them into BT.709/sRGB for the embedded SDR composition surface. This is SDR
  tone mapping, not native HDR display passthrough.
- Automatic caching uses bounded memory; explicit disk caching remains available
  with bounded forward reading. Matroska seeks use indexed subtitle preroll,
  without probing the tail merely to estimate video duration. Underruns rebuffer
  two seconds, and buffering state observes mpv's `paused-for-cache` property.
- Opening the same media as a subtitle-only connection is deferred until video
  playback is ready and three seconds are buffered; media without embedded
  subtitles is not reopened. A session/epoch check rejects stale async work.

## Dolby Vision limitation

Windows uses gpu-next, which can process Dolby Vision metadata with the bundled
modern FFmpeg/libplacebo runtime. Linux's libmpv OpenGL render API uses the legacy
GPU backend, which does not implement Dolby Vision IPTPQc2 reshaping. Profile 5
cannot be corrected merely by tone mapping or overriding the color matrix.

Detected Profile 5 streams now pause with an explicit
error and use the existing Smart Play error recovery when available. Watch
Together does not independently switch sources. HDR10-compatible base layers
remain playable. Older Linux runtimes may not expose the metadata required for
this detection. Full Profile 5 playback in the embedded Linux player still
requires a renderer/runtime change; this patch does not claim to provide it.

## Platform playback checks still required

Run on Windows and Linux (X11 and Wayland), including integrated and discrete
GPUs. Use the same media/source before and after and record click-to-first-frame,
`hwdec-current`, `decoder-frame-drop-count`, `frame-drop-count`, `avsync`, CPU/GPU
load, and the native mpv log. Do not infer a speedup merely from passing unit tests.

| Media / action | Expected |
| --- | --- |
| 1080p H.264 SDR, local and HTTP | Correct colors, continuous audio/video |
| HEVC Main10 HDR10 and HLG, 4K 24/60 fps | Correct SDR tone mapping; no green/purple cast |
| Dolby Vision Profile 5 | Windows: correct colors; Linux: explicit unsupported error/recovery |
| Dolby Vision with HDR10-compatible base layer | Normal HDR10 tone mapping on Linux |
| Slow/chunked HTTP and cold torrent gateway | First decodable frame without a second startup media request |
| Resume/seek in a large remote MKV | No unindexed subtitle scan or duration-only tail probe |
| Embedded/external subtitles; translated subtitles | Existing selection/translation remains functional |
| Pause, resize, fullscreen, 120/144 Hz display | Responsive controls; no unnecessary paused-frame redraws |
| Rapid episode/source changes and close/reopen | No stale subtitle attachment, crash, or render-after-destroy |
| Stream underrun and recovery | Buffering reflects paused-for-cache and recovers |

Sources: [mpv render API threading contract](https://github.com/mpv-player/mpv/blob/master/include/mpv/render.h),
[libmpv render backends](https://github.com/mpv-player/mpv/blob/master/video/out/vo_libmpv.c),
[mpv playback/color/cache options](https://mpv.io/manual/stable/).
