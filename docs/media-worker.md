# Optional Aurales service

`media-worker` is a separately deployable Rust service. It imports the exact
stream-ranking implementation used by the desktop app through
`packages/aurales-domain`; it does not copy the scoring algorithm into a new
backend. It exposes authenticated stream ranking, allowlisted bounded stream
probing, a direct-media proxy with bounded HLS playlist rewriting, and an
opt-in FFmpeg conversion job API. FFmpeg is disabled unless an explicit
executable path is configured, and capabilities report detected encoders.

## Build and run

Install the Rust toolchain supported by this repository (Rust 1.88 or newer),
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
media hostnames. Keep `AURALES_MEDIA_ALLOWED_HOSTS` empty unless proxy playback
is required. To enable conversion, install a trusted FFmpeg build and set
`AURALES_FFMPEG_PATH=/usr/bin/ffmpeg`; otherwise omit it. Example file:

```dotenv
AURALES_MEDIA_API_KEY=replace-with-unique-random-secret-at-least-32-bytes
AURALES_MEDIA_SESSION_KEY=replace-with-a-different-random-secret-at-least-32-bytes
AURALES_MEDIA_WEB_ORIGINS=https://aurales.example.com
AURALES_MEDIA_ALLOWED_HOSTS=cdn.example.net,video.example.org
# Optional; leave unset to disable FFmpeg conversion.
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
| `AURALES_MEDIA_API_KEY` | Yes | Private bearer key, at least 32 bytes. Enter this key in Aurales Settings on each device that should use this worker. |
| `AURALES_MEDIA_SESSION_KEY` | When proxy is enabled | Separate private signing key, at least 32 bytes. Required with `AURALES_MEDIA_ALLOWED_HOSTS`; never reuse the API key. |
| `AURALES_MEDIA_WEB_ORIGINS` | Yes | Comma-separated exact HTTPS origins, such as `https://aurales.example`. `http://localhost` is accepted for local development. Wildcards, paths, credentials, and non-local HTTP origins are rejected. |
| `AURALES_MEDIA_ALLOWED_HOSTS` | For media proxy | Comma-separated exact DNS hostnames permitted as upstream media sources, such as `cdn.example.net,video.example.org`. Wildcards, ports, IP addresses, HTTP URLs, and unlisted hosts are rejected. Leave empty to disable proxy sessions. |
| `AURALES_MEDIA_BIND` | No | Listen address; defaults to `127.0.0.1:8188`. |
| `AURALES_MEDIA_EXTERNAL_TLS` | Only for public binds | Set to `1` only when binding a non-loopback address behind a TLS-terminating reverse proxy. |
| `AURALES_FFMPEG_PATH` | Optional | Explicit FFmpeg executable path. Unset disables conversions. The worker checks available AAC and `libx264` encoders at startup. |
| `AURALES_MEDIA_CONVERSION_DIR` | Optional with FFmpeg | Private, dedicated directory for source and converted files. Defaults to the OS temporary directory under `aurales-media-worker`. |

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
a provider URL or follows a network redirect. Provider credentials and
authorization headers are not accepted.

After a browser decode error, Aurales offers modes reported by the worker:

- **Stream-copy remux** copies the first video and audio tracks into a seekable,
  fast-start MP4 without re-encoding.
- **AAC audio conversion** copies video unchanged and converts the first audio
  track to AAC, avoiding a full video transcode when only audio is incompatible.
- **H.264/AAC conversion** encodes the first video track to H.264 and audio to
  AAC. It is offered only when the configured FFmpeg build has both encoders.

The full source is downloaded before converted playback starts. Each source
and output is capped at 8 GiB, two conversions may run concurrently, eight jobs
may be retained, and FFmpeg is capped at two hours per job. Finished files and
signed playback sessions expire after four hours; a cleanup task removes them,
and stale worker-named files are cleared at startup. The signed media endpoint
supports Range requests for seeking after conversion completes. Allow enough
private disk for two input/output pairs. Run FFmpeg as a restricted OS account
with memory, CPU, and filesystem quotas; worker limits do not replace OS-level
process isolation.

Aurales tries direct playback first; conversion is user-triggered after a
browser decode failure. The worker does not convert HLS, accept provider
authorization headers, handle DRM, or accept arbitrary FFmpeg arguments.

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
FFmpeg jobs accept allowlisted direct media files only. They cannot solve
provider URL expiry or DRM requirements that depend on provider-specific
HTTP headers.
