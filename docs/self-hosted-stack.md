# Self-host the Aurales web app and media worker together

The repository includes a Docker Compose deployment that builds the existing
browser app and the Rust media worker from the same checkout. A single
`docker compose up -d --build` starts both behind Caddy on one hostname. Caddy
serves the PWA and forwards `/health` and `/v1/*` to the worker over the private
Compose network; there is no second hostname or separately exposed worker
port. The worker keeps its API, session, and access-code credentials server-side.
The private API key is not embedded in `dist-web` or sent to browsers.

## Requirements

- A Linux server with Docker Engine and the Docker Compose plugin.
- A DNS `A`/`AAAA` record for the hostname pointing to that server.
- Inbound TCP ports 80 and 443 available so Caddy can issue and renew HTTPS
  certificates.
- Exact media CDN hostnames for `AURALES_MEDIA_ALLOWED_HOSTS`. Leave this empty
  to disable media proxying and conversion. Wildcards are rejected by the
  worker by design.

## Start the complete stack

```sh
git clone --branch master https://github.com/Febsho/Aurales.git Aurales
cd Aurales
cp .env.docker.example .env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 24
```

Put the two different generated values in `.env` for
`AURALES_MEDIA_API_KEY` and `AURALES_MEDIA_SESSION_KEY`. Set a separate
`AURALES_MEDIA_ACCESS_CODE` of at least 16 characters and share it only with
people allowed to use the worker. Set `AURALES_DOMAIN` and the exact allowed
media hostnames. Restrict the file and start the stack:

```sh
chmod 600 .env
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 web media-worker
```

Open `https://<AURALES_DOMAIN>`. The first build compiles the browser client and
worker. Caddy stores its certificates in a named volume. Future updates use
`git pull` followed by `docker compose up -d --build`.

## Unlock the bundled worker in Aurales

In **Settings → Player → Aurales media service**, enter the instance access code
and choose **Unlock service** on each browser/device. The browser receives a
30-day, same-origin `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The private
API key and signing key stay server-side. The app uses the worker on its own
HTTPS origin, so no separate URL or CORS hostname is needed. Choose
**Disconnect** to expire the cookie.

The access code is shared by the instance owner with authorized users. Failed
attempts are throttled per forwarded client IP. Rotate the code and session
signing key in `.env` and recreate the worker container to revoke sessions.
The code is shared across authorized users rather than tied to individual
Aurales accounts; rotate it to revoke all access if it is shared too broadly.

The app remains usable without configuring the worker: browser-direct playback
and local stream ranking continue to work. Proxy playback and media conversion
require both a configured worker and an allowlisted upstream host. FFmpeg is
included in the worker image; the worker will report only the conversion modes
supported by the included build.

## Security and browser limits

Treat `.env` as a server secret and expose only the Caddy web ports. Do not add
the worker key to a Vite variable, HTML bootstrap response, or public JavaScript.
The worker API performs provider relays and bounded media proxy operations, so
its bearer key must remain private. Use an Aurales deployment you trust. This
access gate applies only to the media worker; Aurales profiles remain local to
each browser and sync behavior stays governed by the existing Aurales Sync
service.

The worker can remux or transcode allowlisted direct files, but must download
the whole source before conversion. It cannot bypass DRM, provider-specific
authorization, expiring source URLs, or CORS requirements at the source. HLS
playlists can be proxied and rewritten, but HLS conversion is not supported.
Codec and HDR/Dolby Vision support still varies by browser and device. See
[`media-worker.md`](media-worker.md) for route behavior and limits.
