#!/usr/bin/env bash
# Evidence that conversations, handoffs and the signing key survive a container restart.
# Usage: scripts/restart-evidence.sh > docs/evidence/restart.log   (stack running: docker compose up -d)
set -euo pipefail
API=${API:-http://127.0.0.1:3000}
login() { curl -sf "$API/auth/token" -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"demo-$1\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token'; }
wait_ready() { for _ in $(seq 1 60); do curl -sf "$API/health" >/dev/null && return 0; sleep 2; done; echo "API did not come back"; exit 1; }

echo "== $(date -Iseconds) before restart"
M=$(login cliente1988)
# Bodies go through stdin so non-ASCII text stays UTF-8 whatever the console codepage is.
TURN=$(curl -sf "$API/chat" -H "authorization: Bearer $M" -H 'content-type: application/json' --data-binary @- <<'JSON'
{"message":"Quero falar com um atendente"}
JSON
)
C=$(echo "$TURN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).conversation_id')
H=$(echo "$TURN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).handoff.handoff_id')
echo "conversation $C, handoff $H"
curl -sf "$API/conversations/$C" -H "authorization: Bearer $M" | node -pe 'const v=JSON.parse(require("fs").readFileSync(0)); JSON.stringify({messages: v.messages.length, open_handoff: v.open_handoff})'

echo "== docker compose restart api"
docker compose restart api >/dev/null
wait_ready
echo "== $(date -Iseconds) after restart (same token, issued before the restart)"
curl -sf "$API/conversations/$C" -H "authorization: Bearer $M" | node -pe 'const v=JSON.parse(require("fs").readFileSync(0)); JSON.stringify({messages: v.messages.length, open_handoff: v.open_handoff, last: v.messages.at(-1).content.slice(0, 80)})'
O=$(login op.ana)
echo "queue after restart:"
curl -sf "$API/operator/handoffs" -H "authorization: Bearer $O" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync(0)).items.filter(h => h.id === '$H').map(h => ({id: h.id, status: h.status, version: h.version})))"
echo "operator replies after the restart:"
curl -sf "$API/operator/handoffs/$H/resolve" -H "authorization: Bearer $O" -H 'content-type: application/json' --data-binary @- <<'JSON' |
{"action":"reply","message":"Olá! Aqui é a Ana, já estou com o seu pedido.","expected_version":1}
JSON
 node -pe 'const r=JSON.parse(require("fs").readFileSync(0)); JSON.stringify({status: r.handoff.status, message: r.message})'
curl -sf "$API/ready" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)))'
