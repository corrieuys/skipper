#!/usr/bin/env bash
set -euo pipefail

WHISPER_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/whisper.cpp"
MODEL_DIR="$WHISPER_DIR/models"
DEFAULT_MODEL="base.en"

echo "==> Setting up whisper.cpp in $WHISPER_DIR"

# Clone or update whisper.cpp
if [ -d "$WHISPER_DIR/.git" ]; then
  echo "==> whisper.cpp already cloned, pulling latest..."
  git -C "$WHISPER_DIR" pull --ff-only
else
  echo "==> Cloning whisper.cpp..."
  git clone https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
fi

# Build whisper-server with ffmpeg support
echo "==> Building whisper-server (with ffmpeg support)..."
cd "$WHISPER_DIR"
cmake -B build -DWHISPER_FFMPEG=ON
cmake --build build --config Release -j "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

# Verify binary exists
SERVER_BIN="$WHISPER_DIR/build/bin/whisper-server"
if [ ! -f "$SERVER_BIN" ]; then
  # Older whisper.cpp versions put it in build/bin/server
  SERVER_BIN="$WHISPER_DIR/build/bin/server"
fi

if [ ! -f "$SERVER_BIN" ]; then
  echo "ERROR: Could not find whisper-server binary after build."
  echo "Check build output above for errors."
  exit 1
fi

echo "==> whisper-server built at: $SERVER_BIN"

# Download default model
MODEL_FILE="$MODEL_DIR/ggml-${DEFAULT_MODEL}.bin"
if [ -f "$MODEL_FILE" ]; then
  echo "==> Model $DEFAULT_MODEL already downloaded."
else
  echo "==> Downloading model: $DEFAULT_MODEL..."
  bash "$WHISPER_DIR/models/download-ggml-model.sh" "$DEFAULT_MODEL"
fi

echo ""
echo "Setup complete!"
echo "  Binary: $SERVER_BIN"
echo "  Model:  $MODEL_FILE"
echo ""
echo "To start manually:"
echo "  $SERVER_BIN -m $MODEL_FILE --host 127.0.0.1 --port 8080 --convert"
echo ""
echo "Or use the --start-whisper flag:"
echo "  bun run index.ts --start-whisper"
