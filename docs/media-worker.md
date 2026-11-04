# Optional Aurales service

`media-worker` is a separately deployable Rust service. It imports the exact
stream-ranking implementation used by the desktop app through
`packages/aurales-domain`; it does not copy the scoring algorithm into a new
backend. It exposes authenticated stream ranking, allowlisted bounded stream
probing, a direct-media proxy with bounded HLS playlist rewriting, and an
opt-in FFmpeg conversion job API. FFmpeg is disabled unless an explicit
executable path is configured, and capabilities report detected encoders.

## Browser playback strategy

The browser first plays the provider URL directly. If the browser reports an
unsupported media format, it asks the configured worker for `mode: "auto"`.
Desktop converted output is requested as HLS for hls.js over Media Source
Extensions. Mobile browsers receive a seekable MP4 instead, which uses the
browser's native video decoder and avoids mobile HLS/MSE compatibility
differences. The player inspects the worker's per-format muxer capabilities and
falls back to the other format only when the preferred one is unavailable.
Extensionless source URLs are classified from an allowlisted `HEAD` response,
with a bounded Range request and manifest-prefix sniff when `HEAD` is rejected
or returns a generic content type.
The worker downloads the allowlisted HTTPS source into its private conversion
directory, lets FFmpeg inspect the actual streams, and `mode: "auto"` tries
these output profiles in order for the selected container:

1. `-c copy` stream remux (video and audio copied).
2. `-c:v copy -c:a aac` (only audio encoded).
3. H.264/AAC encoding (video encoding is the last fallback).
If the automatic ladder cannot produce output or a browser rejects standard
H.264 playback, mobile browsers can escalate through 720p/30 and SD 480-line/
30 fps H.264/AAC profiles.

Each attempt must complete successfully before it is returned. The status
response reports the mode that actually worked, and the player shows that mode.
FFmpeg also regenerates missing presentation timestamps from decoding
timestamps before muxing and shifts negative output timestamps to zero. These
steps repair some malformed timelines and help mobile browser demuxers start
playback and seek reliably.
Before choosing a conversion result, the worker runs `ffprobe` on the downloaded
bytes and returns a bounded, token-free summary of the detected container and
audio/video codec names and profiles to the player. URL suffixes and upstream
MIME types are not treated as source-format proof.
If the browser rejects a valid remux or audio-only output, the player asks the
worker for the next stage; it does not advance merely because the prior FFmpeg
job completed.
HLS conversion needs FFmpeg's HLS muxer and MPEG-TS support; MP4 conversion
needs the MP4 muxer. AAC-only conversion and the later video fallback also need
AAC encoding. Video fallback prefers a detected VideoToolbox, NVENC,
QSV, or AMF H.264 encoder, then falls back to `libx264` if that encoder cannot
run. To enable this path, configure `AURALES_FFMPEG_PATH`
and verify the capabilities endpoint reports conversion support. Browser
Direct Play remains available when no worker is configured.

For Stremio-compatible add-ons, `behaviorHints.proxyHeaders.request` is sent to
the worker only in the authenticated session/conversion request body. The
worker validates and retains these headers only in the in-memory session or
active job, applies them to the original source origin, and strips them after a
cross-origin redirect. If the add-on omits them, Aurales supplies the current
browser User-Agent and app-origin Referer for worker requests, matching the
context used by direct mobile browser requests. Explicit add-on values take
precedence. The public playback URL contains only an opaque signed session
identifier and expiry, never provider headers.

Worker conversions return a single-file MPEG-TS HLS VOD playlist. The manifest
and segment endpoint share the same expiring signed session; segment requests
support byte ranges for seeking and resume. The worker rewrites the segment URI
to that signed endpoint and serves it as `video/mp2t`. Existing provider HLS
uses the proxy session path, which rewrites nested playlists, keys, maps, and
segment references into expiring signed child sessions; the browser uses native HLS when
`canPlayType` reports it (notably Safari/iOS) and otherwise loads `hls.js` over
Media Source Extensions. Live playlist reloads pass through LL-HLS `_HLS_msn`,
`_HLS_part`, and `_HLS_skip` directives after validation while preserving the
provider's original query credentials. Codec/container compatibility remains
browser-dependent: notably HEVC, AV1, VP9 profiles, HDR, and Dolby Vision vary by
OS, browser, hardware, and DRM. Successful remux only proves FFmpeg can package
the streams; it does not guarantee a browser decoder can play them.
When an HLS decoder error occurs, the worker can also convert finite VOD
playlists. Desktop conversion follows the highest-bandwidth variant. Mobile
compatibility conversion first favors variants at or below 60 fps, then prefers
resolutions within the encoder's 1080p bounds and selects the highest resolution
within those bounds. If none fit, it selects the smallest known resolution. If
variants omit resolution metadata, it favors rates up to 60 fps, then the
highest bandwidth. It downloads allowlisted segments and init maps, materializes
explicit and implicit byte-range segments
and byte-range init maps, and supports identity AES-128 keys before feeding a
local playlist to FFmpeg. For master playlists it preserves up to eight external
audio renditions, including
their language and default flags, in the local master playlist. It resolves playlist variables declared
with `NAME`/`VALUE`, inherited with `IMPORT`, or read from the playlist query
with `QUERYPARAM`. External subtitle renditions from the selected variant are
also materialized into local playlists so FFmpeg can expose text tracks to the
player; an unavailable or unsupported optional subtitle rendition is skipped
without failing video conversion. Same-origin HLS references inherit missing query parameters from their
manifest URL; AWS `X-Amz-*` signed URLs remain unchanged. A finite live media
playlist can be materialized as a snapshot of its currently listed full
segments; the generated local playlist is ended after that snapshot. In Low-Latency
HLS playlists the worker materializes trailing parts only from the first part
marked `INDEPENDENT=YES`, and ignores preload hints. This also permits a
part-only snapshot when it contains an independent part; delta updates, nested
audio or subtitle masters, SAMPLE-AES, DRM key formats, and non-HTTP resources
are rejected. Live passthrough remains
available through the secure HLS proxy for streams the browser can decode.

Static MPEG-DASH MPDs with a single-file `SegmentBase`, finite `SegmentList`
entries, or bounded `SegmentTemplate` timelines are materialized, including multiple periods. Dynamic MPDs are supported as finite snapshots when their segment references are bounded. On mobile, an MPD with `availabilityStartTime` can also snapshot open-ended `SegmentTemplate` timelines across periods: the worker estimates the live edge from the manifest publication time (or its clock), applies the suggested presentation delay, and retains the advertised time-shift buffer (five minutes when omitted):
When that window contains more than 4,096 references, the snapshot keeps the
newest references within the worker's bounded manifest limit.
mobile compatibility conversion first favors video representations at or
below 60 fps, then prefers resolutions within the encoder's 1080p bounds and
selects the highest resolution within those bounds. If none fit, it selects the
smallest known resolution; representations without resolution metadata favor
rates up to 60 fps, then highest bandwidth. Desktop keeps the highest-bandwidth
representation. The worker
downloads the selected video and up to eight language-labeled audio
representations through the same HTTPS allowlist, validates ranged segments,
then exposes them to FFmpeg as local HLS VOD playlists with discontinuities and
period-specific init maps.
Supported text subtitle representations are materialized across periods and
extracted to WebVTT sidecars alongside embedded and HLS subtitle tracks.
For `SegmentBase`, the worker passes the complete media resource to FFmpeg as a
single HLS segment and includes a separately hosted initialization resource
when the MPD provides one. Relative DASH references inherit missing query
parameters from same-origin base URLs, while AWS `X-Amz-*` signed URLs keep
their path-specific query unchanged.
Template expansion supports `RepresentationID`,
`Bandwidth`, `Number`, `Time`, and zero-padded numeric formats. Bounded `r="-1"`
timeline repeats are expanded using the next explicit timeline time, the finite
segment list, or the period duration. Dynamic MPDs without a usable
`availabilityStartTime` for an open-ended timeline, dynamic `SegmentBase`
representations, more than 128 periods, unbounded/oversized
timelines, inconsistent audio presence between periods, and protected
representations are rejected.

The repository's FFmpeg integration fixtures exercise these paths: H.264/AAC
MP4 is stream-copy remuxed; H.264/Opus Matroska becomes AAC audio with copied
H.264 video; VP8/Opus WebM reaches the H.264/AAC video fallback. When the local
FFmpeg build provides the optional encoders, generated HEVC Main 10/AC-3 and
AV1/Opus sources also exercise the mobile video-and-audio fallback. The tests
inspect the produced H.264 profile, level, pixel format, frame rate, and
dimensions, including a generated 60 fps input. The browser matrix covers HLS
VOD seeking through MSE on desktop. Its iOS WebKit and Android Chromium
projects also decode and seek a mobile H.264 Baseline Level 3.0 MP4 fixture;
Android additionally exercises worker handoff and fallback escalation. These
projects emulate mobile profiles and do not replace tests on physical devices.
The FFmpeg integration also feeds materialized MPEG-TS HLS segments through
the mobile H.264/AAC MP4 conversion path.
For mobile video encoding (including HLS fallback when
MP4 muxing is unavailable), the worker uses H.264 Baseline Level 4.2 and scales
landscape video to at most 1920×1080 and portrait video to at most 1080×1920.
Its video filter caps output frame rates at 60 fps while preserving known
lower source rates; when source frame-rate metadata is missing or invalid, it
uses 30 fps. Using the filter avoids a dependency on newer FFmpeg output
options and keeps the fallback within Level 4.2 frame-size and macroblock-rate
limits for wider mobile decoder compatibility. Desktop HLS encoding retains
the source resolution; remux and audio-only paths keep source video unchanged.
Audio-transcode fallbacks encode AAC-LC at 48 kHz and
downmix to stereo in both MP4 and HLS output for wider browser decoder support;
stream-copy remux keeps the source codec, sample rate, and channel layout.
MP4 outputs retain all audio tracks for language
selection when possible; if conversion fails with multiple tracks, the worker
retries the first eight tracks individually and reports when it had to reduce
the track set. The
single-variant HLS output retains its first audio track. Up to eight embedded
or selected external HLS/DASH text subtitle tracks are
extracted to signed WebVTT sidecars for the player; bitmap subtitle formats such
as PGS are not converted.

## Build and run

Install the Rust toolchain supported by this repository (Rust 1.89 or newer),
then from the repository root build the service:

```sh
cargo build --release --manifest-path media-worker/Cargo.toml
```

Run the worker tests with:

```sh
cargo test --manifest-path media-worker/Cargo.toml
```

## Linux systemd deployment

The repository includes a hardened service unit at
[`deploy/systemd/aurales-media-worker.service`](../deploy/systemd/aurales-media-worker.service)
and a Caddy reverse-proxy example at
[`deploy/caddy/aurales-media-worker.Caddyfile`](../deploy/caddy/aurales-media-worker.Caddyfile).
The service listens on loopback; terminate HTTPS at Caddy or Nginx. Do not
expose port 8188 publicly.

Build on a compatible Linux host, or cross-build for the worker host's target,
then install the binary and service account:

```sh
cargo build --release --manifest-path media-worker/Cargo.toml
sudo useradd --system --home-dir /var/lib/aurales-media-worker \
  --shell /usr/sbin/nologin aurales-media
sudo install -d -o aurales-media -g aurales-media -m 0700 /opt/aurales/bin
sudo install -o root -g root -m 0755 \
  media-worker/target/release/aurales-media-worker \
  /opt/aurales/bin/aurales-media-worker
sudo install -o root -g root -m 0644 \
  deploy/systemd/aurales-media-worker.service \
  /etc/systemd/system/aurales-media-worker.service
```

Create `/etc/aurales-media-worker.env` as root with mode `0600`. Use unique
random values for both keys, and list the exact HTTPS frontend origin and exact
media hostnames. For HLS/DASH, include every hostname used by the root manifest,
variant manifests, segments, external audio/subtitle renditions, and redirects;
the worker does not infer or allow sibling CDN hosts. Keep
`AURALES_MEDIA_ALLOWED_HOSTS` empty unless proxy playback is required. To enable
conversion, install a trusted FFmpeg build and set
`AURALES_FFMPEG_PATH=/usr/bin/ffmpeg`; otherwise omit it. Example file:

```dotenv
AURALES_MEDIA_API_KEY=replace-with-unique-random-secret-at-least-32-bytes
AURALES_MEDIA_SESSION_KEY=replace-with-a-different-random-secret-at-least-32-bytes
AURALES_MEDIA_WEB_ORIGINS=https://aurales.example.com
AURALES_MEDIA_ALLOWED_HOSTS=cdn.example.net,video.example.org
# Optional; leave unset to disable media conversion (FFmpeg and FFprobe are required).
# AURALES_FFMPEG_PATH=/usr/bin/ffmpeg
```

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/aurales-media-worker.env
sudoedit /etc/aurales-media-worker.env
sudo systemctl daemon-reload
sudo systemctl enable --now aurales-media-worker
sudo systemctl status aurales-media-worker
curl http://127.0.0.1:8188/health
```

Install Caddy and copy the example site block to its active Caddyfile, replacing
`media.example.com` with the worker hostname. Validate and reload Caddy with
`caddy validate --config /etc/caddy/Caddyfile` and
`sudo systemctl reload caddy`. The proxy endpoint must be HTTPS. Caddy is
configured without access logs so signed media query strings are not written to
disk. If using Nginx, preserve that rule: disable access logs on the worker
location or redact query strings for `/v1/media/*`.

After enabling the service, verify the public `https://media.example.com/health`
endpoint, then configure that HTTPS base URL and the API key under **Settings →
Player → Optional self-hosted media worker** and select **Save and test**.
Never use the worker API key as a frontend build variable. For upgrades, install
the new binary, restart the service, and verify `/health` before deploying the
frontend that depends on a new worker capability.

For an authenticated post-deployment check, set the public worker URL and exact
Aurales app origin, then enter the API key without echoing it into shell history:

```sh
export AURALES_MEDIA_WORKER_URL=https://media.example.com
export AURALES_MEDIA_SMOKE_ORIGIN=https://aurales.example.com
read -s AURALES_MEDIA_API_KEY
export AURALES_MEDIA_API_KEY
npm run smoke:media-worker
unset AURALES_MEDIA_API_KEY
```

This checks health, API-key rejection and acceptance, and the exact-origin CORS
preflight. To also check a real signed media session, Range delivery, and
tampered-signature rejection, set `AURALES_MEDIA_SMOKE_URL` to an HTTPS media
URL whose hostname is in `AURALES_MEDIA_ALLOWED_HOSTS` before running the
command. The smoke check fetches only the first 16 bytes.

When `ffmpeg` and `ffprobe` are available on `PATH`, the suite also runs the
real local-file remux, audio-only AAC, and H.264/AAC conversion pipeline and
checks the resulting stream codecs. The production service still enables
conversion only when `AURALES_FFMPEG_PATH` is explicitly configured.

Create a private environment file outside the web root and restrict it to the
service account. Generate separate random values for the API and session keys:

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Set these variables for the service:

| Variable | Required | Meaning |
| --- | --- | --- |
| `AURALES_MEDIA_API_KEY` | Yes | Private bearer key, at least 32 bytes. Used by trusted standalone clients; integrated browser deployments use `AURALES_MEDIA_ACCESS_CODE` and keep this key server-side. |
| `AURALES_MEDIA_SESSION_KEY` | When proxy or access code is enabled | Separate private signing key, at least 32 bytes. Required with `AURALES_MEDIA_ALLOWED_HOSTS` or `AURALES_MEDIA_ACCESS_CODE`; never reuse the API key. |
| `AURALES_MEDIA_ACCESS_CODE` | Optional | Shared access code for an integrated public web deployment, at least 16 bytes. It exchanges for a 30-day same-origin HttpOnly cookie. The API key remains server-side. Use HTTPS and share the code only with authorized users. |
| `AURALES_MEDIA_WEB_ORIGINS` | Yes | Comma-separated exact HTTPS origins, such as `https://aurales.example`. `http://localhost` is accepted for local development. Wildcards, paths, credentials, and non-local HTTP origins are rejected. |
| `AURALES_MEDIA_ALLOWED_HOSTS` | For media proxy | Comma-separated exact DNS hostnames permitted as upstream media sources, such as `cdn.example.net,video.example.org`. For HLS/DASH, list each host used by manifests, segments, external audio/subtitle tracks, and redirects. Wildcards, ports, IP addresses, HTTP URLs, and unlisted hosts are rejected. Leave empty to disable proxy sessions. |
| `AURALES_MEDIA_BIND` | No | Listen address; defaults to `127.0.0.1:8188`. |
| `AURALES_MEDIA_EXTERNAL_TLS` | Only for public binds | Set to `1` only when binding a non-loopback address behind a TLS-terminating reverse proxy. |
| `AURALES_FFMPEG_PATH` | Optional | Explicit FFmpeg executable path. Unset disables conversions. FFprobe must be installed beside FFmpeg or on `PATH`; startup checks both tools and discovers AAC, `libx264`, hardware encoders, and the HLS/MPEG-TS muxers needed for browser conversion. MP4 muxing is needed only for explicit MP4 conversion requests. |
| `AURALES_MEDIA_CONVERSION_DIR` | Optional with FFmpeg | Private, dedicated directory for source and converted files. Defaults to the OS temporary directory under `aurales-media-worker`. |
| `AURALES_MEDIA_MAX_CONVERSION_GIB` | Optional with FFmpeg | Maximum bytes for each downloaded source and converted output, in GiB. Defaults to `8`; accepts integers from `1` to `64`. Ensure the private conversion volume has room for concurrent inputs and outputs. |
| `AURALES_MEDIA_CONVERSION_TIMEOUT_MINUTES` | Optional with FFmpeg | Maximum runtime for one complete conversion job, including source downloads, FFmpeg processing, and subtitle extraction. Defaults to `120` minutes; accepts integers from `1` to `1440`. |

Example local launch:

```sh
AURALES_MEDIA_API_KEY='replace-with-a-unique-64-character-hex-key' \
AURALES_MEDIA_SESSION_KEY='replace-with-a-different-unique-64-character-hex-key' \
AURALES_MEDIA_WEB_ORIGINS='https://aurales.example' \
AURALES_MEDIA_ALLOWED_HOSTS='cdn.example.net' \
./media-worker/target/release/aurales-media-worker
```

For internet deployment, keep the worker bound to loopback and put a TLS proxy
in front of it. For example, Caddy can proxy `media.example.com` to
`127.0.0.1:8188`; keep the API key in the service environment and configure
the exact Aurales site origin in `AURALES_MEDIA_WEB_ORIGINS`. Do not expose the
worker without HTTPS, do not put the API key in a `VITE_` build variable, and
do not reuse a media-provider credential as the worker key.

Minimal Caddy site configuration:

```caddyfile
media.example.com {
    reverse_proxy 127.0.0.1:8188
}
```

Caddy obtains and renews the TLS certificate. Keep access logging disabled for
this site, or configure it to omit query strings, because signed playback URLs
carry bearer signatures in their query. Bind the worker to loopback as shown by
the default; `AURALES_MEDIA_EXTERNAL_TLS=1` is only needed when the worker
itself binds a non-loopback address behind a TLS proxy.

## Configure Aurales

Build the browser app with `npm run build:web` and deploy `dist-web/` with the
same-origin history fallback described in [WEB_PLATFORM_AUDIT.md](../WEB_PLATFORM_AUDIT.md).
In **Settings → Player → Optional self-hosted media worker**, enter the HTTPS
worker URL and private API key, then choose **Save and test**. The saved key is
kept in local storage on that device and excluded from profile backups and
Aurales Sync. When configured, browser stream ranking calls the authenticated
worker; if it is unavailable, Aurales falls back to its local scorer.

The endpoints are `GET /health`, authenticated `GET /v1/capabilities`,
authenticated `POST /v1/streams/rank`, authenticated `POST /v1/media/probe`,
authenticated `POST /v1/providers/pmdb`, authenticated
`POST /v1/providers/mdblist`, authenticated `POST /v1/media/sessions`,
authenticated `POST /v1/providers/trakt`, authenticated `POST /v1/providers/torbox`,
authenticated `POST /v1/providers/aurales-sync`,
authenticated `POST /v1/media/conversions`, authenticated
`GET /v1/media/conversions/{jobId}`, and signed `GET`/`HEAD /v1/media/{id}`.
The capabilities response includes `conversionTimeoutSeconds` so the browser
can keep polling for the configured FFmpeg runtime.
Failed conversion status responses include `sourceHost` when an upstream HTTP
response or child-host allowlist check identifies the failing hostname. This
field contains only the normalized hostname; URLs, paths, query strings, and
provider headers are never returned in it.
Conversion requests from mobile browsers set `mobileCompatibility: true`; this
also applies the mobile H.264 limits when the worker must fall back to HLS.
The MDBList relay accepts only GET/POST/PUT/DELETE calls to the fixed
`api.mdblist.com` HTTPS origin. It supports JSON account requests, API-key
requests, and form-encoded OAuth token exchanges; it never follows redirects.
When a browser worker is configured, Aurales uses this route for MDBList
account and OAuth calls, avoiding provider CORS restrictions.
The Trakt relay accepts only GET/POST/PUT/DELETE calls to the fixed
`api.trakt.tv` HTTPS origin, only forwards `Content-Type`, `trakt-api-key`,
`trakt-api-version`, and `Authorization`, never follows redirects, and applies
the same request/response size, timeout, public-DNS pinning, and concurrency
limits. Browser Trakt device-code, refresh, account, list, history, and playback
requests use it when configured; otherwise the app uses direct browser fetch.
Trakt tokens and any user-supplied client secret in an OAuth request pass through
the configured worker, so configure only infrastructure you trust.
The TorBox relay accepts only GET/POST requests for the exact Aurales device-auth,
user, cached-torrent, torrent-list, create-torrent, and download-link endpoints on
`api.torbox.app`. It bounds request and response sizes, pins public DNS, disables
redirects, and shares the provider concurrency limit. Browser TorBox calls use the
relay when configured and direct HTTPS otherwise. Device codes and TorBox account
tokens transit the configured worker; it does not persist them. Configure only
infrastructure you trust.
The Aurales Sync relay is pinned to `sync.febsho.me` and permits only POSTs to
`/v1/auth/login`, `/v1/auth/register`, and `/v1/sync`. It preserves the existing
Aurales Sync request and response bodies, limits request bodies to 10 MiB and
responses to 16 MiB, pins public DNS, disables redirects, and uses the bounded
provider concurrency pool. Use it when a self-hosted browser origin is not
allowed by the first-party Sync API's CORS policy. Without a worker, the app
continues to call Sync directly. Sync passwords, access tokens, and sync records
transit the configured worker and are forwarded only to `sync.febsho.me`; the
worker does not persist them. Configure only infrastructure you trust.
The stream-probe endpoint accepts at most one URL and samples at most 256 KiB
using a Range request. It uses the same shared Rust range-header interpretation
as the desktop probe, follows only allowlisted HTTPS redirects, and is limited
to eight concurrent probes with a 500 ms–30 s bounded timeout. It returns the
final URL only to the authenticated caller that submitted the source. Ranking accepts at most 250 candidates
and a 1 MiB JSON body; concurrent ranking is bounded. Session creation accepts
only HTTPS URLs on the exact configured hostname allowlist. The worker resolves
and checks public IP addresses, pins the upstream connection to the checked
address, disables automatic redirects, and rechecks every permitted redirect.
Media sessions stay in memory and expire after four hours. The worker caps
active root sessions at 256 and all root/child resources at 16,384. Streaming is capped at 16 concurrent responses; stalled
upstreams time out after 45 seconds without data. The proxy forwards `Range`
and `If-Range` and relays safe content/range headers without buffering the media body. It does not accept
provider authorization headers on media sessions. Provider relay requests are
restricted to fixed HTTPS provider origins and use the authenticated worker key;
credentials are forwarded only to the corresponding provider. Do not log request
bodies for any `/v1/providers/*` route. Source URLs may contain signed query tokens;
the worker keeps these URLs in memory, does not echo or log them, and never
returns them to the browser. Operate the worker only on infrastructure you
trust. A signed session URL is a bearer secret: keep reverse-proxy access logs
disabled or redact the query string on `/v1/media/*`, and do not log request
bodies for `POST /v1/media/sessions`. Do not share these URLs.

### Optional FFmpeg conversion

Set `AURALES_FFMPEG_PATH` to enable conversion. Keep the conversion directory
outside the web root, owned by the worker account, and inaccessible to other
users. A dedicated disk or volume is recommended. The worker downloads a source
only after HTTPS allowlist validation, public DNS resolution, IP pinning, and
per-redirect revalidation. FFmpeg reads a local downloaded file; it never opens
a provider URL or follows a network redirect. Optional provider request headers
are accepted only in the authenticated request and scoped to the original
source origin.

After a direct-play browser decode error, Aurales automatically tries the
conversion modes reported by the worker in this order:

- **Stream-copy remux** copies the first video and audio tracks into a seekable,
  fast-start MP4 without re-encoding.
- **AAC audio conversion** copies video unchanged and converts the first audio
  track to AAC, avoiding a full video transcode when only audio is incompatible.
- **H.264/AAC conversion** encodes the first video track to H.264 and audio to
  AAC. It is offered only when the configured FFmpeg build has both encoders.
- **Lower compatibility H.264/AAC conversion** limits output to 720p/30 and
  Baseline Level 3.1 for devices that reject the standard mobile profile. The
  worker advertises this mode separately so older worker versions are not sent
  an unsupported request.
- **SD compatibility H.264/AAC conversion** limits output to 480 lines/30 fps
  and Baseline Level 3.0 for devices that reject the 720p profile.

The full source is downloaded before converted playback starts. Each source
and output defaults to an 8 GiB cap, configurable up to 64 GiB with
`AURALES_MEDIA_MAX_CONVERSION_GIB`. Two conversions may run concurrently, eight jobs
may be retained, and each whole conversion job is capped at two hours by
default; this can be configured up to 24 hours with
`AURALES_MEDIA_CONVERSION_TIMEOUT_MINUTES`.
Finished files and
signed playback sessions expire after four hours; a cleanup task removes them,
and stale worker-named files are cleared at startup. The signed media endpoint
supports Range requests for seeking after conversion completes. Allow enough
private disk for two input/output pairs. Run FFmpeg as a restricted OS account
with memory, CPU, and filesystem quotas; worker limits do not replace OS-level
process isolation.

Aurales always tries direct playback first. If it fails with a browser decode
error and a compatible worker conversion is available, the player automatically
tries the modes above and switches to the first successful seekable copy. The
original source is not modified. This requires a configured worker with FFmpeg
enabled; a browser cannot transcode media on-device. The worker converts
allowlisted direct media and supported finite HLS/DASH inputs, including bounded
snapshots of live manifests. Provider request headers are accepted only in the
authenticated conversion request and are scoped to the original source origin.
The worker cannot convert DRM-protected media or accept arbitrary FFmpeg
arguments.

The PMDB relay is fixed to HTTPS `publicmetadb.com` under `/api/external`; it
does not accept arbitrary origins, follows no redirects, allows only GET,
POST, PUT, and DELETE, and is limited to eight concurrent requests. Each body
is limited to 1 MiB, each response to 16 MiB, and each request to 30 seconds.
The PMDB API key is sent in the authenticated request body and forwarded only
as an Authorization header to PublicMetaDB. Configure this only with a worker
you trust; the key is not stored by the worker or included in its responses.
Aurales uses this route only when the worker is configured; without it, the
browser attempts PublicMetaDB directly and remains subject to provider CORS.

The browser retries streams through this proxy after a network error when a
worker is configured. For HLS, the worker rewrites URI attributes and segment
lines to signed child sessions, including nested playlists, HTTP(S) segment
URLs, AES key URLs, and subtitle playlists. HLS bodies are limited to 2 MiB
and 4,096 references per playlist; child URLs share the parent expiry and stale
children receive a short grace period. Non-HTTP schemes such as `skd://` are
preserved for platform DRM handling. HLS sessions remain direct proxy sessions;
FFmpeg jobs accept allowlisted direct media files and supported HLS VOD only.
They cannot solve provider URL expiry or DRM requirements that depend on
provider-specific HTTP headers.
