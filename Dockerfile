# Build the browser application and Rust media worker from the same Aurales
# checkout so the two deploy together as one self-hosted stack.
FROM node:22-bookworm-slim AS web-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:web

FROM rust:1.88-bookworm AS worker-build
WORKDIR /app
COPY packages/aurales-domain ./packages/aurales-domain
COPY media-worker ./media-worker
RUN cargo build --release --manifest-path media-worker/Cargo.toml

FROM caddy:2-alpine AS web-runtime
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/dist-web /srv

FROM debian:bookworm-slim AS worker-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
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
ENTRYPOINT ["/usr/local/bin/aurales-media-worker"]
