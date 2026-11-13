#!/bin/bash
# Starts the probe's production build (its own process), then: HTTP probes, WS probe, one signal ($1: INT, TERM, INT2).
set -u
S=${PROBE_OUT:-/tmp}; L=$S/probe-prod.log; : > "$L"
cd /home/tristan/DEV/llama-webui/app/probe
PROBE_LOG=$L NITRO_PORT=7872 NITRO_HOST=0.0.0.0 PROBE_CLOSE_MS=${CLOSE_MS:-1500} node .output/server/index.mjs > "$S/probe-prod.out" 2>&1 &
V=$!
for i in $(seq 1 60); do curl -s --noproxy '*' -o /dev/null http://127.0.0.1:7872/api/item && break; sleep 0.25; done
if [ "${HTTP:-0}" = 1 ]; then B=http://192.168.0.20:7872 bash "$(dirname "$0")/probe-http.sh"; WS_URL=ws://192.168.0.20:7872/ws node probe-ws.ts; curl -s --noproxy '*' -I http://127.0.0.1:7872/assets/$(ls .output/public/assets | head -1) | tr -d '\r' | grep -i "cache-control\|content-type"; fi
CHILD=$(grep -o 'child=[0-9]*' "$L" | head -1 | cut -d= -f2)
T0=$(date +%s%N)
case "${1:-INT}" in INT2) kill -INT $V; sleep 0.3; kill -INT $V ;; *) kill -"${1:-INT}" $V ;; esac
for i in $(seq 1 120); do kill -0 $V 2>/dev/null || break; sleep 0.25; done
echo "exit after $(( ($(date +%s%N)-T0)/1000000 )) ms"; kill -0 $V 2>/dev/null && echo "STILL ALIVE"
grep -v "^\s*at " "$L"; tail -3 "$S/probe-prod.out"
[ -n "$CHILD" ] && { kill -0 "$CHILD" 2>/dev/null && { echo "CHILD $CHILD ORPHANED"; kill "$CHILD"; } || echo "child $CHILD gone"; }
kill -0 $V 2>/dev/null && kill -KILL $V; true
