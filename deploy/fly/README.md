# The Arc demo on Fly.io: runbook

One Fly machine runs Fuel's API, the founder's shop, the Try-it door and its
approver, each as its own system user (api, shop, tryit, approver). Only the door (port 3220) faces the
internet, through Fly's proxy at `https://fuel-arc-demo.fly.dev`. The API,
the shop and the approver listen on loopback inside the machine.

```
internet ──HTTPS──> Fly proxy ──> door (user tryit, agent key only)
                                   ├──> Fuel API 127.0.0.1:3200 (user api: demo DB, agent chain key)
                                   │       └──> shop 127.0.0.1:3210 (user shop: shop chain key, settles on Arc)
                                   └──> approver 127.0.0.1:3230 (user approver, operator key only)
```

## Deploy

Everything below runs from the repository root. Nothing prints a key.

1. **Safe mode first.** No chain key on the machine; the API refuses every
   demo payment as "not armed"; the shop does not start.

   ```bash
   fly apps create fuel-arc-demo
   fly volumes create fuel_data --region sin --size 1 --app fuel-arc-demo
   # Fuel's own keys and the token key, read from the demo's env file without echoing them:
   grep -E '^(FUEL_API_KEY|FUEL_AGENT_KEY|FUEL_TOKEN_ENCRYPTION_KEY)=' ~/.fuel-arc/fuel-arc.env | fly secrets import --app fuel-arc-demo
   fly deploy --ha=false --build-arg FUEL_COMMIT=$(git rev-parse --short HEAD)
   fly status --app fuel-arc-demo   # exactly ONE machine, or stop and ask why
   ```

   Then check: `curl -s https://fuel-arc-demo.fly.dev/try/status` answers, and
   a Buy from the proof page reports "Not completed" (not armed).

2. **The demo database.** Stop the Mac's demo first (`scripts/arc-demo/stop.sh`)
   so the ledger is quiet, then copy it up as `.incoming` and restart; the
   entrypoint installs it before the API opens anything.

   ```bash
   fly ssh sftp shell --app fuel-arc-demo <<< 'put ~/.fuel-arc/fuel-arc.db /data/fuel-arc.db.incoming'
   fly machine restart --app fuel-arc-demo
   ```

   From this moment the Mac's copy must never run again: two ledgers would
   each allow the agent's $5. Rename it: `mv ~/.fuel-arc/fuel-arc.db ~/.fuel-arc/fuel-arc.db.moved-to-fly`.

3. **Arm it** (real money from here). The two chain keys go straight from
   their files into Fly's secret store; the next boot writes them to 0600
   files on the machine's root filesystem, never on the volume.

   ```bash
   { printf 'ARC_AGENT_KEY=%s\nARC_SHOP_KEY=%s\n' "$(cat ~/.fuel-arc/agent.key)" "$(cat ~/.fuel-arc/shop.key)"; } | fly secrets import --app fuel-arc-demo
   ```

   `fly secrets import` restarts the machine. Check the log says
   `armed: both chain keys present`, then make the one live test from the
   proof page.

4. **The agent's cap for judges** (an operator setting; moves no money):

   ```bash
   fly ssh console --app fuel-arc-demo -C "sh -c 'cd /app && FUEL_API_KEY=\$FUEL_API_KEY node --import tsx demo/try-it/control.ts cap 1.03'"
   ```

## Switches

Run on the machine with `fly ssh console --app fuel-arc-demo`, then `cd /app`:

| Command | Effect |
|---|---|
| `node --import tsx demo/try-it/control.ts pause` | the door answers "closed" to everyone; nothing reaches Fuel |
| `... control.ts resume` | reopens it |
| `FUEL_API_KEY=$FUEL_API_KEY node --import tsx demo/try-it/control.ts freeze` | Fuel refuses every payment by the agent (423) |
| `... control.ts unfreeze` | |
| `... control.ts status` | the door's view: open or why, today's total, recent attempts |
| `... control.ts agent` | the agent as Fuel sees it: cap, spent, frozen |
| `fly secrets unset ARC_AGENT_KEY ARC_SHOP_KEY` | disarm: back to safe mode on the next boot |
| `fly machine stop <id>` | the hard stop: nothing runs until `fly machine start` |

The door closes itself when today's forwarded total would pass $0.20, when
the shop wallet is under $0.50 or the agent wallet under $0.05, or when it
has not been able to read the balances for ten minutes.

## Logs and the proof page

`fly logs --app fuel-arc-demo`. The door's own log of every attempt is
`/data/tryit/tryit-log.jsonl` on the volume, next to the pause file; it
survives restarts and redeploys. Copy it down with `fly ssh sftp get`. The ledger is
`/data/fuel-arc.db`; copy it down the same way to regenerate the proof page
with `scripts/arc-demo/publish-proof.ts` (which reads `~/.fuel-arc/fuel-arc.db`).

## Never

- Never run the Mac's `scripts/arc-demo/start.sh mainnet` again while Fly holds the database.
- Never set `FUEL_COOKIE_SECURE`, Fireblocks or QuickBooks secrets on this app: Fly secrets reach every process's environment at boot, and `env -i` is what keeps them out of the children.
- Never raise `max_machines_running` above 1.
