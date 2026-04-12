#!/bin/sh
# Wait for the Ollama service to be ready and pull the embed model.
# Called from docker-compose command before the bot starts.

HOST="${OLLAMA_EMBED_HOST:-http://ollama:11434}"
MODEL="${OLLAMA_EMBED_MODEL:-nomic-embed-text}"

echo "[wait-for-ollama] Waiting for Ollama at $HOST..."
for i in $(seq 1 30); do
  if curl -sf "$HOST/api/tags" > /dev/null 2>&1; then
    echo "[wait-for-ollama] Ollama is ready"
    echo "[wait-for-ollama] Pulling $MODEL..."
    curl -sf "$HOST/api/pull" -d "{\"name\":\"$MODEL\"}"
    echo ""
    echo "[wait-for-ollama] Model $MODEL ready"
    exit 0
  fi
  sleep 1
done

echo "[wait-for-ollama] WARNING: Ollama not reachable after 30s, starting bot without embeddings"
exit 0
