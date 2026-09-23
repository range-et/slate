#!/usr/bin/env bash
set -euo pipefail

SERVER="${LLAMA_SERVER:-$(command -v llama-server || true)}"
if [[ -z "$SERVER" && -x "$HOME/.docker/bin/inference/llama-server" ]]; then
  SERVER="$HOME/.docker/bin/inference/llama-server"
fi
if [[ -z "$SERVER" ]]; then
  echo "llama-server was not found. Install it with: brew install llama.cpp" >&2
  exit 1
fi

PORT="${SLATE_LLAMA_PORT:-8080}"
CACHE_DIR="${SLATE_LLAMA_CACHE:-$HOME/Library/Caches/slate}"
MODEL="${SLATE_LLAMA_MODEL_PATH:-$CACHE_DIR/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf}"
MODEL_URL="https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf?download=true"

if [[ ! -f "$MODEL" ]]; then
  mkdir -p "$CACHE_DIR"
  echo "Downloading the 491 MB demo model to $MODEL"
  curl --fail --location --progress-bar "$MODEL_URL" --output "$MODEL.part"
  mv "$MODEL.part" "$MODEL"
fi

echo "Starting Slate's local llama.cpp server on http://127.0.0.1:${PORT}"
echo "Model: ${MODEL}"
exec "$SERVER" --host 127.0.0.1 --port "$PORT" --ctx-size 4096 --model "$MODEL"
