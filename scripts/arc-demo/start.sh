#!/bin/bash
# Starts the Arc founder demo: Fuel's API on 127.0.0.1:3200 and the founder's
# shop on 127.0.0.1:3210. Never 3000 or 3100, never fuel.db.
#
#   scripts/arc-demo/start.sh <rehearsal|mainnet>       stop: scripts/arc-demo/stop.sh
#
# Each process gets a minimal environment built here (env -i): its own
# database and keys from ~/.fuel-arc/<instance>.env, the one key file it needs,
# and nothing else -- no .env (DOTENV_CONFIG_PATH=/dev/null), so no Fireblocks
# or QuickBooks credentials exist in either process. No value is echoed.
set -euo pipefail
cd "$(dirname "$0")/../.."
D="$HOME/.fuel-arc"
case "${1:-}" in
  rehearsal) ENVF=rehearsal.env; AGENT=test-agent.key; SHOP=test-shop.key; CHAIN="Arc testnet" ;;
  mainnet)   ENVF=fuel-arc.env;  AGENT=agent.key;      SHOP=shop.key;      CHAIN="Arc mainnet" ;;
  *) echo "usage: $0 <rehearsal|mainnet>"; exit 2 ;;
esac

# The code's MAINNET_DEMO.chain has to be the chain asked for.
LITERAL=$(node --import tsx -e 'import("./src/payments/arc-chain.ts").then(m => console.log(m.MAINNET_DEMO.chain.label))')
if [ "$LITERAL" != "$CHAIN" ]; then echo "MAINNET_DEMO.chain is '$LITERAL', not '$CHAIN'; not starting."; exit 1; fi
# Mainnet runs only reviewed, committed code: the lock is "a reviewed commit",
# and node would otherwise execute whatever is on disk.
if [ "$1" = mainnet ]; then
  PATHS=(src demo scripts/arc-demo package.json package-lock.json tsconfig.json)
  if ! git diff --quiet HEAD -- "${PATHS[@]}" || [ -n "$(git ls-files --others --exclude-standard -- "${PATHS[@]}")" ]; then
    echo "uncommitted or untracked changes under ${PATHS[*]}; commit (and review) them first. Not starting."; exit 1
  fi
fi
COMMIT=$(git rev-parse --short HEAD)
for port in 3200 3210; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is already in use; not starting."; exit 1; fi
done

if [ ! -r "$D/$ENVF" ]; then echo "$D/$ENVF is missing; run scripts/arc-demo/setup.ts $1 first. Not starting."; exit 1; fi
mkdir -p "$D/logs" && chmod 700 "$D/logs"
STAMP=$(date +%Y%m%d-%H%M%S)
BASEENV=(PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" DOTENV_CONFIG_PATH=/dev/null)

env -i "${BASEENV[@]}" ARC_SHOP_KEY_FILE="$D/$SHOP" PORT=3210 \
  nohup node --import tsx demo/arc-shop/server.ts > "$D/logs/shop-$1-$STAMP.log" 2>&1 &
echo $! > "$D/shop.pid"

# The instance's own keys are read from its env file INSIDE the child shell,
# so they never appear as command-line arguments (visible to `ps`).
env -i "${BASEENV[@]}" ENVFILE="$D/$ENVF" X402_PAY_TO=0x0000000000000000000000000000000000000402 PORT=3200 \
  FUEL_ARC_DEMO_KEY_FILE="$D/$AGENT" \
  nohup bash -c 'set -e; set -a; . "$ENVFILE"; set +a; unset ENVFILE; : "${FUEL_DB_PATH:?not set: refusing to fall back to fuel.db}"; exec node --import tsx src/server.ts' > "$D/logs/api-$1-$STAMP.log" 2>&1 &
echo $! > "$D/api.pid"

for i in $(seq 1 60); do
  if curl -s -o /dev/null http://127.0.0.1:3200/health && curl -s -o /dev/null http://127.0.0.1:3210/; then break; fi
  sleep 1
done
echo "commit $COMMIT ($1)" | tee -a "$D/logs/api-$1-$STAMP.log" >/dev/null
echo "running commit $COMMIT"
echo "API  http://127.0.0.1:3200  pid $(cat "$D/api.pid")   log $D/logs/api-$1-$STAMP.log"
echo "shop http://127.0.0.1:3210  pid $(cat "$D/shop.pid")   log $D/logs/shop-$1-$STAMP.log"
grep -h "\[arc-shop\]" "$D/logs/shop-$1-$STAMP.log" | tail -2 || true
