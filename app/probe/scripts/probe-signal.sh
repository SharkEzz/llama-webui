#!/bin/bash
# Starts its own Vite dev server for the probe, sends it one signal ($1, default INT; "INT2" = two SIGINTs), reports.
set -u
S=${PROBE_OUT:-/tmp}; L=$S/probe-signal.log; : > "$L"
cd /home/tristan/DEV/llama-webui/app/probe
PROBE_LOG=$L node ../../node_modules/vite/bin/vite.js dev --port 7871 > "$S/probe-signal.out" 2>&1 &
V=$!
for i in $(seq 1 60); do curl -s --noproxy '*' -o /dev/null http://127.0.0.1:7871/api/item && break; sleep 0.25; done
CHILD=$(grep -o 'child=[0-9]*' "$L" | head -1 | cut -d= -f2)
echo "vite=$V child=$CHILD"
case "${1:-INT}" in
  INT2) kill -INT $V; sleep 0.3; kill -INT $V ;;
  *) kill -"${1:-INT}" $V ;;
esac
for i in $(seq 1 40); do kill -0 $V 2>/dev/null || break; sleep 0.25; done
kill -0 $V 2>/dev/null && echo "vite still alive after 10 s" || echo "vite exited"
cat "$L"
[ -n "$CHILD" ] && { kill -0 "$CHILD" 2>/dev/null && { echo "CHILD $CHILD ORPHANED"; kill "$CHILD"; } || echo "child $CHILD gone"; }
kill -0 $V 2>/dev/null && kill -KILL $V
