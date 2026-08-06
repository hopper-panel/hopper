#!/usr/bin/env bash
#
# The walk an operator takes on their first hour, asserted.
#
# Every step here failed silently in a released version at some point, and
# none of the failures were visible to lint, typecheck or the unit suite:
#
#   - the reinstall route answered 404, because it was never registered
#   - a failed installation left the row at INSTALLING with no verdict
#   - a server on any port other than 25565 was unreachable, because the
#     template's configFiles were never applied
#
# So the assertions are about what an operator would see, not about internals.
set -euo pipefail

API=http://127.0.0.1:8080
PORT=25566

say() { printf '\n--- %s\n' "$1"; }
fail() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }

TOKEN=$(curl -fsS -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d "{\"identifier\":\"ci\",\"password\":\"$HOPPER_ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
auth=(-H "authorization: Bearer $TOKEN")

say "give the node a pool of ports"
NODE=$(curl -fsS "${auth[@]}" "$API/api/admin/nodes?perPage=10" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["uuid"])')
curl -fsS -o /dev/null -X POST "${auth[@]}" -H 'content-type: application/json' \
  "$API/api/admin/nodes/$NODE/allocations" -d "{\"ip\":\"0.0.0.0\",\"ports\":[\"$PORT-$((PORT + 4))\"]}"

ALLOC=$(curl -fsS "${auth[@]}" "$API/api/admin/nodes/$NODE/allocations?perPage=100" \
  | python3 -c "
import sys, json
print([a['id'] for a in json.load(sys.stdin)['data'] if a['port'] == $PORT][0])
")

say "create a server on $PORT — not the default"
OWNER=$(curl -fsS "${auth[@]}" "$API/api/auth/me" | python3 -c 'import sys,json;print(json.load(sys.stdin)["uuid"])')
TEMPLATE=$(curl -fsS "${auth[@]}" "$API/api/admin/templates?perPage=100" | python3 -c "
import sys, json
body = json.load(sys.stdin)
rows = body['data'] if isinstance(body, dict) else body
print([t['uuid'] for t in rows if t['name'] == 'Paper'][0])
")

UUID=$(curl -fsS -X POST "${auth[@]}" -H 'content-type: application/json' "$API/api/admin/servers" -d "{
  \"name\": \"ci\",
  \"ownerUuid\": \"$OWNER\",
  \"nodeUuid\": \"$NODE\",
  \"templateUuid\": \"$TEMPLATE\",
  \"allocationId\": $ALLOC,
  \"memoryBytes\": 1610612736,
  \"diskBytes\": 3221225472,
  \"cpuPercent\": 0,
  \"startOnCompletion\": false
}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["uuid"])')

say "the installation reaches a verdict"
# It used to reach none at all: the failure branch reported nothing and the
# success report sat behind a `return`. A server that never leaves INSTALLING
# is the shape that bug takes.
for _ in $(seq 1 60); do
  sleep 10
  STATUS=$(curl -fsS "${auth[@]}" "$API/api/servers/$UUID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = READY ] && break
  [ "$STATUS" = INSTALL_FAILED ] && fail "the installation failed"
done
[ "$STATUS" = READY ] || fail "still $STATUS after ten minutes — no verdict was ever reported"

say "reinstall answers, rather than 404"
# The panel posted to a route the daemon never registered, and the interface
# reported that as "is the node reachable?".
curl -fsS -o /dev/null -X POST "${auth[@]}" "$API/api/servers/$UUID/reinstall"

for _ in $(seq 1 60); do
  sleep 10
  STATUS=$(curl -fsS "${auth[@]}" "$API/api/servers/$UUID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = READY ] && break
done
[ "$STATUS" = READY ] || fail "the server did not come back from a reinstall"

say "start it once — the first start, which is where the port bug lived"
curl -fsS -o /dev/null -X POST "${auth[@]}" -H 'content-type: application/json' \
  "$API/api/servers/$UUID/power" -d '{"action":"start"}'

for _ in $(seq 1 60); do
  sleep 10
  docker logs --tail 5 "hopper-$UUID" 2>&1 | grep -q 'Done (' && break
done

say "the configuration carries the allocated port"
# Minecraft writes server.properties on its own first run, so there was
# nothing to rewrite and the first start bound 25565 while Docker published
# 25566. The panel showed an address nobody could connect to.
grep -q "^server-port=$PORT$" "/var/lib/hopper/volumes/$UUID/server.properties" \
  || fail "server.properties does not name $PORT: $(grep '^server-port' "/var/lib/hopper/volumes/$UUID/server.properties" || true)"

say "and the server answers there"
# A TCP connection proves nothing on its own — docker-proxy accepts before it
# discovers there is nothing listening behind. This speaks the protocol.
python3 - "$PORT" <<'PY'
import json, socket, struct, sys

port = int(sys.argv[1])

def varint(value):
    out = b''
    while True:
        byte = value & 0x7F
        value >>= 7
        out += bytes([byte | (0x80 if value else 0)])
        if not value:
            return out

host = '127.0.0.1'
sock = socket.create_connection((host, port), timeout=15)

payload = b'\x00' + varint(770) + varint(len(host)) + host.encode() + struct.pack('>H', port) + b'\x01'
sock.sendall(varint(len(payload)) + payload)
sock.sendall(varint(1) + b'\x00')

def read(sock):
    result = shift = 0
    while True:
        byte = sock.recv(1)[0]
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result
        shift += 7

read(sock)
read(sock)
length = read(sock)

data = b''
while len(data) < length:
    chunk = sock.recv(length - len(data))
    if not chunk:
        break
    data += chunk

status = json.loads(data.decode('utf-8'))
print('   answered:', status['version']['name'])
PY

printf '\nA server on %s installs, reinstalls, starts and answers.\n' "$PORT"
