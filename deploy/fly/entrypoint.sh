#!/bin/bash
# Starts the Arc founder demo inside the Fly machine, mirroring
# scripts/arc-demo/start.sh: each process gets a minimal environment with
# only what it needs, built here with `env -i`, and runs as its own user.
#
# Secrets arrive as environment variables (fly secrets):
#   ARC_AGENT_KEY   the demo agent's private key     -> /home/api/.fuel-arc/agent.key  (api only)
#   ARC_SHOP_KEY    the shop wallet's private key    -> /home/shop/.fuel-arc/shop.key  (shop only)
#   FUEL_API_KEY    Fuel's operator key              -> api (to check callers) and approver
#   FUEL_AGENT_KEY  Fuel's agent key                 -> api (to check callers) and door
#   FUEL_TOKEN_ENCRYPTION_KEY                        -> api
#
# The two chain keys are written to 0600 files on the machine's root
# filesystem (ephemeral, recreated at every boot), never on the /data volume,
# which Fly snapshots. They are unset from this shell as soon as written.
#
# What lives on the volume: the ledger (/data/fuel-arc.db, user api) and the
# door's state (/data/tryit: its attempt log and the pause file, user tryit),
# so a restart neither resets the daily cap nor reopens a paused door.
#
# SAFE MODE: with ARC_AGENT_KEY and ARC_SHOP_KEY absent, the API starts
# unarmed (every demo payment is refused as "not armed" before any request)
# and the shop does not start. Everything else runs, so the door, approver
# and API can be tested publicly with no key on the machine.
#
# If any process exits, this script exits, and Fly restarts the machine.
set -euo pipefail
cd /app
COMMIT="${FUEL_COMMIT:-unknown}"
echo "[entrypoint] commit $COMMIT"

for v in FUEL_API_KEY FUEL_AGENT_KEY FUEL_TOKEN_ENCRYPTION_KEY TRYIT_PAUSE_FILE TRYIT_LOG_FILE; do
  if [ -z "${!v:-}" ]; then echo "[entrypoint] $v is not set; not starting"; exit 1; fi
done
if [ "$FUEL_API_KEY" = "$FUEL_AGENT_KEY" ]; then echo "[entrypoint] the two Fuel keys are equal; not starting"; exit 1; fi

# The volume is mounted root-owned; fix that here, every boot, before anything
# opens it. 711, not 700: the door (user tryit) must be able to reach its own
# folder /data/tryit through /data, and the first safe-mode boot showed what
# 700 does -- the door cannot stat its pause file, and (correctly) fails
# closed as "paused". Nobody but api can list /data or read the ledger (600).
chown api:fuel /data && chmod 711 /data
install -d -m 700 -o tryit -g fuel /data/tryit
# Key folders: 0700, owned by the one user that may read them (src/payments/arc-demo.ts, demo/arc-shop/server.ts check both).
install -d -m 700 -o api -g fuel /home/api/.fuel-arc
install -d -m 700 -o shop -g fuel /home/shop/.fuel-arc
for u in api shop tryit approver; do install -d -m 700 -o "$u" -g fuel "/tmp/$u"; done
rm -f /home/api/.fuel-arc/agent.key /home/shop/.fuel-arc/shop.key
ARMED=0
if [ -n "${ARC_AGENT_KEY:-}" ] && [ -n "${ARC_SHOP_KEY:-}" ]; then
  (umask 077; printf '%s\n' "$ARC_AGENT_KEY" > /home/api/.fuel-arc/agent.key; printf '%s\n' "$ARC_SHOP_KEY" > /home/shop/.fuel-arc/shop.key)
  chown api:fuel /home/api/.fuel-arc/agent.key; chown shop:fuel /home/shop/.fuel-arc/shop.key
  ARMED=1
  echo "[entrypoint] armed: both chain keys present"
else
  echo "[entrypoint] SAFE MODE: no chain keys; the API runs unarmed and the shop does not start"
fi
unset ARC_AGENT_KEY ARC_SHOP_KEY

DB=/data/fuel-arc.db
# A database copied up while the previous boot was running lands as
# .incoming (deploy/fly/README.md); it replaces the live one here, before the
# API opens anything, so a half-written copy is never opened mid-run.
if [ -f "$DB.incoming" ]; then
  echo "[entrypoint] installing $DB.incoming as the demo database"
  mv -f "$DB.incoming" "$DB"
  rm -f "$DB-wal" "$DB-shm" "$DB-journal"
fi
touch "$DB" && chown api:fuel "$DB" && chmod 600 "$DB"

BASE=(PATH="$PATH" DOTENV_CONFIG_PATH=/dev/null NODE_ENV=production FUEL_COMMIT="$COMMIT")
pids=()

# Fuel's API: the demo database, Fuel's own keys, and (armed) the agent's chain key file.
ARM=()
[ "$ARMED" = 1 ] && ARM=(FUEL_ARC_DEMO_KEY_FILE=/home/api/.fuel-arc/agent.key)
env -i "${BASE[@]}" HOME=/home/api TMPDIR=/tmp/api FUEL_DB_PATH="$DB" PORT=3200 X402_PAY_TO=0x0000000000000000000000000000000000000402 \
  FUEL_API_KEY="$FUEL_API_KEY" FUEL_AGENT_KEY="$FUEL_AGENT_KEY" FUEL_TOKEN_ENCRYPTION_KEY="$FUEL_TOKEN_ENCRYPTION_KEY" "${ARM[@]}" \
  runuser -u api -- node --import tsx src/server.ts &
pids+=($!)

if [ "$ARMED" = 1 ]; then
  env -i "${BASE[@]}" HOME=/home/shop TMPDIR=/tmp/shop ARC_SHOP_KEY_FILE=/home/shop/.fuel-arc/shop.key PORT=3210 \
    runuser -u shop -- node --import tsx demo/arc-shop/server.ts &
  pids+=($!)
fi

# The approver: the operator key, loopback only, its own user so the door cannot read its environment.
env -i "${BASE[@]}" HOME=/home/approver TMPDIR=/tmp/approver FUEL_API_KEY="$FUEL_API_KEY" PORT=3230 \
  runuser -u approver -- node --import tsx demo/try-it/approver-server.ts &
pids+=($!)

# The door: the agent key only, on all interfaces (the Fly proxy is the only way in).
env -i "${BASE[@]}" HOME=/home/tryit TMPDIR=/tmp/tryit FUEL_AGENT_KEY="$FUEL_AGENT_KEY" PORT=3220 HOST=0.0.0.0 \
  TRYIT_TRUST_FLY_CLIENT_IP=1 TRYIT_ALLOWED_ORIGIN="${TRYIT_ALLOWED_ORIGIN:-https://vasanog.github.io}" \
  TRYIT_PAUSE_FILE="$TRYIT_PAUSE_FILE" TRYIT_LOG_FILE="$TRYIT_LOG_FILE" \
  runuser -u tryit -- node --import tsx demo/try-it/door-server.ts &
pids+=($!)

unset FUEL_API_KEY FUEL_AGENT_KEY FUEL_TOKEN_ENCRYPTION_KEY
trap 'kill "${pids[@]}" 2>/dev/null' EXIT
wait -n
echo "[entrypoint] a process exited; stopping so Fly restarts the machine"
exit 1
