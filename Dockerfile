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
