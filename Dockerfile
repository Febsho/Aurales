# Build the browser application and Rust media worker from the same Aurales
# checkout so the two deploy together as one self-hosted stack.
FROM node:22-bookworm-slim AS web-build
WORKDIR /app
ARG VITE_AURALES_INTEGRATED_MEDIA_WORKER=true
ARG VITE_TMDB_API_KEY
ARG VITE_TVDB_API_KEY
ARG VITE_OMDB_API_KEY
ARG VITE_SIMKL_V2_CLIENT_ID
ARG VITE_SIMKL_WEB_REDIRECT_URI
ARG VITE_TRAKT_CLIENT_ID
ARG VITE_ANILIST_WEB_CLIENT_ID
ARG VITE_ANILIST_CLIENT_ID
ARG VITE_MDBLIST_CLIENT_ID
ARG VITE_MDBLIST_WEB_REDIRECT_URI
ENV VITE_AURALES_INTEGRATED_MEDIA_WORKER=${VITE_AURALES_INTEGRATED_MEDIA_WORKER}
ENV VITE_TMDB_API_KEY=${VITE_TMDB_API_KEY} \
    VITE_TVDB_API_KEY=${VITE_TVDB_API_KEY} \
    VITE_OMDB_API_KEY=${VITE_OMDB_API_KEY} \
    VITE_SIMKL_V2_CLIENT_ID=${VITE_SIMKL_V2_CLIENT_ID} \
    VITE_SIMKL_WEB_REDIRECT_URI=${VITE_SIMKL_WEB_REDIRECT_URI} \
    VITE_TRAKT_CLIENT_ID=${VITE_TRAKT_CLIENT_ID} \
    VITE_ANILIST_WEB_CLIENT_ID=${VITE_ANILIST_WEB_CLIENT_ID} \
    VITE_ANILIST_CLIENT_ID=${VITE_ANILIST_CLIENT_ID} \
    VITE_MDBLIST_CLIENT_ID=${VITE_MDBLIST_CLIENT_ID} \
    VITE_MDBLIST_WEB_REDIRECT_URI=${VITE_MDBLIST_WEB_REDIRECT_URI}
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:web

FROM rust:1.89-bookworm AS worker-build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY packages/aurales-domain ./packages/aurales-domain
COPY media-worker ./media-worker
RUN cargo build --release --manifest-path media-worker/Cargo.toml

FROM caddy:2-alpine AS web-runtime
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/dist-web /srv

FROM debian:bookworm-slim AS worker-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ffprobe -version >/dev/null \
    && ffmpeg -hide_banner -encoders 2>&1 | awk '$2 == "libx264" { h264=1 } $2 == "aac" { aac=1 } END { exit !(h264 && aac) }' \
    && ffmpeg -hide_banner -muxers 2>&1 | awk '$2 == "mp4" { mp4=1 } $2 == "hls" { hls=1 } END { exit !(mp4 && hls) }' \
    && ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=640x360:rate=30:duration=1' -f lavfi -i 'sine=frequency=1000:sample_rate=48000:duration=1' -vf format=yuv420p -c:v libx264 -profile:v baseline -level:v 3.0 -c:a aac -profile:a aac_low -ar 48000 -ac 2 -avoid_negative_ts make_zero -movflags +faststart -shortest -f mp4 /tmp/aurales-mobile-profile-check.mp4 \
    && ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,level,pix_fmt -of default=noprint_wrappers=1 /tmp/aurales-mobile-profile-check.mp4 | awk -F= '$1 == "codec_name" && $2 == "h264" { h264=1 } $1 == "profile" && $2 == "Constrained Baseline" { baseline=1 } $1 == "level" && $2 == "30" { level=1 } $1 == "pix_fmt" && $2 == "yuv420p" { pixel_format=1 } END { exit !(h264 && baseline && level && pixel_format) }' \
    && ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,profile -of csv=p=0 /tmp/aurales-mobile-profile-check.mp4 | awk -F, '$1 == "aac" && $2 == "LC" { aac=1 } END { exit !aac }' \
    && ffmpeg -hide_banner -loglevel error -i /tmp/aurales-mobile-profile-check.mp4 -f null - \
    && rm -f /tmp/aurales-mobile-profile-check.mp4 \
    && ffmpeg -hide_banner -filters 2>&1 | awk '$2 == "zscale" { zscale=1 } $2 == "tonemap" { tonemap=1 } END { exit !(zscale && tonemap) }' \
    && ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=32x32:rate=1:duration=0.5' -vf 'setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084,zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=transfer=bt709:primaries=bt709:matrix=bt709:range=tv,scale=32:32,format=yuv420p' -frames:v 1 -f null - \
    && useradd --system --home-dir /var/lib/aurales --create-home --shell /usr/sbin/nologin aurales
COPY --from=worker-build /app/media-worker/target/release/aurales-media-worker /usr/local/bin/aurales-media-worker
ENV AURALES_MEDIA_BIND=0.0.0.0:8188 \
    AURALES_MEDIA_EXTERNAL_TLS=1 \
    AURALES_FFMPEG_PATH=/usr/bin/ffmpeg \
    AURALES_MEDIA_CONVERSION_DIR=/var/lib/aurales/conversions
RUN install -d -o aurales -g aurales -m 0700 /var/lib/aurales/conversions
USER aurales
EXPOSE 8188
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8188/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/aurales-media-worker"]
