#!/usr/bin/env bash
# setup-binaries.sh
# Linux counterpart to setup-binaries.ps1.
# Fetches the yt-dlp sidecar and makes sure mpv/libmpv/ffmpeg are available so a
# fresh clone builds and runs without any manual steps.
#
# Unlike Windows (where mpv ships as a self-contained .exe + a couple of DLLs),
# libmpv on Linux pulls in a large tree of shared libraries (ffmpeg, libass, ...).
# The idiomatic "batteries included" model here is:
#   * yt-dlp        -> bundled as a sidecar in src-tauri/binaries/ (single static binary)
#   * mpv/ffmpeg    -> installed via the distro package manager (also declared in
#                      tauri.linux.conf.json `depends`, so end-user .deb/.rpm installs
#                      pull them in automatically).
#
# Usage:
#   ./scripts/setup-binaries.sh          # download yt-dlp, offer to install system deps
#   ./scripts/setup-binaries.sh --yes    # also install system deps without prompting
#   ./scripts/setup-binaries.sh --no-deps  # only fetch yt-dlp, skip system deps

set -euo pipefail

ASSUME_YES=0
SKIP_DEPS=0
for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=1 ;;
        --no-deps) SKIP_DEPS=1 ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

# Colors (fall back to empty if not a tty)
if [ -t 1 ]; then
    C_INFO=$'\e[36m'; C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_RESET=$'\e[0m'
else
    C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_RESET=''
fi
info() { echo "${C_INFO}$*${C_RESET}"; }
ok()   { echo "${C_OK}$*${C_RESET}"; }
warn() { echo "${C_WARN}$*${C_RESET}" >&2; }
err()  { echo "${C_ERR}$*${C_RESET}" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../src-tauri/binaries"
mkdir -p "$BIN_DIR"

# --- 1. Determine target triple / yt-dlp asset for this architecture ---
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64)
        TRIPLE="x86_64-unknown-linux-gnu"
        YTDLP_ASSET="yt-dlp_linux"
        ;;
    aarch64|arm64)
        TRIPLE="aarch64-unknown-linux-gnu"
        YTDLP_ASSET="yt-dlp_linux_aarch64"
        ;;
    *)
        err "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# --- 2. Download yt-dlp sidecar ---
YTDLP_DEST="$BIN_DIR/yt-dlp-$TRIPLE"
info "Downloading latest yt-dlp ($YTDLP_ASSET) -> $(basename "$YTDLP_DEST")..."
curl -L --fail --progress-bar \
    -o "$YTDLP_DEST" \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YTDLP_ASSET"
chmod +x "$YTDLP_DEST"
ok "yt-dlp sidecar installed: $("$YTDLP_DEST" --version 2>/dev/null || echo '(version check failed)')"

# --- 3. Ensure system deps: mpv, libmpv, ffmpeg ---
if [ "$SKIP_DEPS" -eq 1 ]; then
    info "Skipping system dependency check (--no-deps)."
    exit 0
fi

have_libmpv() {
    # libmpv.so.2 lives on the loader path; check the common dirs.
    for d in /usr/lib /usr/lib64 /usr/lib/x86_64-linux-gnu /usr/lib/aarch64-linux-gnu; do
        [ -e "$d/libmpv.so.2" ] || [ -e "$d/libmpv.so.1" ] && return 0
    done
    return 1
}

MISSING=()
command -v mpv    >/dev/null 2>&1 || MISSING+=("mpv")
command -v ffmpeg >/dev/null 2>&1 || MISSING+=("ffmpeg")
have_libmpv                       || MISSING+=("libmpv")

if [ "${#MISSING[@]}" -eq 0 ]; then
    ok "System dependencies already present (mpv, libmpv, ffmpeg)."
    ok $'\nAll binaries ready. You can now run: npm run tauri dev'
    exit 0
fi

warn "Missing system dependencies: ${MISSING[*]}"

# Detect package manager and map to package names.
INSTALL_CMD=""
if command -v pacman >/dev/null 2>&1; then
    INSTALL_CMD="sudo pacman -S --needed mpv ffmpeg"      # mpv provides libmpv.so.2
elif command -v apt-get >/dev/null 2>&1; then
    INSTALL_CMD="sudo apt-get install -y mpv libmpv2 ffmpeg"
elif command -v dnf >/dev/null 2>&1; then
    INSTALL_CMD="sudo dnf install -y mpv mpv-libs ffmpeg"
elif command -v zypper >/dev/null 2>&1; then
    INSTALL_CMD="sudo zypper install -y mpv libmpv2 ffmpeg"
else
    err "Could not detect a supported package manager (pacman/apt/dnf/zypper)."
    err "Please install mpv, libmpv, and ffmpeg manually, then re-run."
    exit 1
fi

info "Suggested install command:"
echo "    $INSTALL_CMD"

if [ "$ASSUME_YES" -eq 0 ]; then
    read -r -p "Run it now? [y/N] " reply
    case "$reply" in
        [yY]|[yY][eE][sS]) ;;
        *) warn "Skipped. Run the command above yourself, then re-run this script to verify."; exit 0 ;;
    esac
fi

info "Installing system dependencies..."
eval "$INSTALL_CMD"
ok $'\nAll binaries ready. You can now run: npm run tauri dev'
