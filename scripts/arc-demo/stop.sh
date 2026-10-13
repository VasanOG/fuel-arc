#!/bin/bash
# Stops the Arc demo's two processes, and only them: each recorded pid is
# killed only if it is the node process listening on the demo's own port.
set -uo pipefail
D="$HOME/.fuel-arc"
for pair in api:3200 shop:3210; do
  name=${pair%%:*}; port=${pair##*:}
  pid=$(cat "$D/$name.pid" 2>/dev/null || true)
  listener=$(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [ -n "$pid" ] && [ "$pid" = "$listener" ]; then
    kill "$pid" && echo "stopped $name (pid $pid, port $port)"
  elif [ -n "$listener" ]; then
    echo "port $port is held by pid $listener, which this script did not start; leaving it alone"
  else
    echo "$name is not running"
  fi
  rm -f "$D/$name.pid"
done
