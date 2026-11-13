#!/bin/bash
B=${B:-http://192.168.0.20:7870}
for r in "GET /api/only-post" "PUT /api/item" "DELETE /api/item" "HEAD /api/item" "GET /api/boom" "GET /api/db" "GET /api/ffi" "GET /api/nope" "POST /api/nope" "GET /chat/12" "GET /api" "GET /ws" "POST /ws"; do
  set -- $r; echo "=== $r"
  if [ "$1" = HEAD ]; then curl -s --noproxy '*' -I "$B$2"; else curl -s --noproxy '*' -i -X "$1" "$B$2" | head -c 600; fi | tr -d '\r' | grep -iv "^date\|^connection\|^keep-alive"
  echo
done
