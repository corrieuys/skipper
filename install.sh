#!/usr/bin/env bash
# Install the latest Skipper binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/corrieuys/skipper/main/install.sh | bash
#
# By default this installs the latest STABLE release; GitHub prereleases are
# skipped automatically (they never count as `latest`). Opt into a prerelease:
#   SKIPPER_CHANNEL=beta  curl -fsSL ...install.sh | bash   # newest release incl. prereleases
#   SKIPPER_VERSION=v0.2.0-beta.1  curl -fsSL ...install.sh | bash   # pin an exact release
#
# Override the install dir with SKIPPER_BIN_DIR (default: ~/.local/bin).
set -euo pipefail

REPO="corrieuys/skipper"
BIN_DIR="${SKIPPER_BIN_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os="macos" ;;
  Linux)  os="linux" ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

asset="skipper-${os}-${arch}"

# Resolve which release to pull. Precedence: explicit pin > beta channel > stable.
channel="${SKIPPER_CHANNEL:-stable}"
if [ -n "${SKIPPER_VERSION:-}" ]; then
  url="https://github.com/${REPO}/releases/download/${SKIPPER_VERSION}/${asset}"
  echo "channel: pinned ${SKIPPER_VERSION}"
elif [ "$channel" = "beta" ]; then
  # The list endpoint (unlike /releases/latest) includes prereleases, newest first.
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=10" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  if [ -z "$tag" ]; then
    echo "could not resolve a beta release from the GitHub API" >&2; exit 1
  fi
  url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
  echo "channel: beta (${tag})"
else
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
fi

echo "installing ${asset} -> ${BIN_DIR}/skipper"
mkdir -p "$BIN_DIR"
tmp="$(mktemp)"
if ! curl -fsSL "$url" -o "$tmp"; then
  echo "download failed: $url" >&2
  echo "(no prebuilt binary for ${os}/${arch}? check https://github.com/${REPO}/releases)" >&2
  rm -f "$tmp"; exit 1
fi
chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/skipper"

echo "installed skipper $("$BIN_DIR/skipper" --version 2>/dev/null || echo "") to $BIN_DIR/skipper"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "run: skipper start" ;;
  *) echo "note: $BIN_DIR is not on PATH. add to your shell profile:"; echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
