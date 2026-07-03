#!/usr/bin/env bash
# Seed a General Lighting device into elemu, then run the integration harness.
set -euo pipefail

DASH="${ELEMU_DASHBOARD:-http://elemu:8880}"

echo "[entrypoint] waiting for elemu dashboard at ${DASH} ..."
for i in $(seq 1 30); do
  if curl -fs "${DASH}/api/device/eojs" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[entrypoint] adding General Lighting device 029001 (release R) ..."
curl -fs -X POST "${DASH}/api/device/eojs" \
  -H 'Content-Type: application/json' \
  -d '{"eoj":"029001","release":"R"}' >/dev/null

# Give it a known starting state: ON (0x80=30), 80% brightness (0xB0=50).
curl -fs -X PUT "${DASH}/api/device/eojs/029001/epcs/80" -H 'Content-Type: application/json' -d '{"edt":"30"}' >/dev/null
curl -fs -X PUT "${DASH}/api/device/eojs/029001/epcs/B0" -H 'Content-Type: application/json' -d '{"edt":"50"}' >/dev/null

echo "[entrypoint] running harness ..."
exec node test/docker/harness.mjs
