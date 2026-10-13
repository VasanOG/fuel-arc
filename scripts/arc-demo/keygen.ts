/**
 * Makes one wallet for the Arc founder demo and prints ONLY its public address.
 *
 *   npx tsx scripts/arc-demo/keygen.ts <role>
 *
 * Roles: `agent` and `shop` (Arc mainnet), `test-agent` and `test-shop` (the
 * Arc testnet rehearsal). Separate pairs on purpose: the mainnet keys sign
 * nothing until the first live payment, so a mistake during rehearsal can never
 * touch a funded wallet.
 *
 * WHERE THE KEY GOES. `~/.fuel-arc/<role>.key`, a file only you can read (0600)
 * in a folder only you can open (0700), outside the repository. The address goes
 * beside it in `<role>.address`, which is public.
 *
 * WHAT THIS NEVER DOES:
 *   - print, log or return the key. It exists in this process's memory and in
 *     that one file, nowhere else;
 *   - overwrite a key. The file is opened with O_EXCL, so if it already exists
 *     this stops. Replacing a funded wallet's key would lose the money.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROLES = ["agent", "shop", "test-agent", "test-shop"] as const;
const role = process.argv[2] as (typeof ROLES)[number];
if (!ROLES.includes(role)) {
  console.error(`usage: keygen.ts <${ROLES.join("|")}>`);
  process.exit(2);
}

const dir = join(homedir(), ".fuel-arc");
mkdirSync(dir, { recursive: true, mode: 0o700 });
// mkdir's mode is ignored for a folder that already existed; check it instead.
if ((statSync(dir).mode & 0o077) !== 0) {
  console.error(`${dir} can be read by other users; fix with: chmod 700 ${dir}`);
  process.exit(1);
}

const keyPath = join(dir, `${role}.key`);
const addressPath = join(dir, `${role}.address`);
if (existsSync(keyPath)) {
  console.error(`${keyPath} already exists; refusing to replace it. Its address: ${existsSync(addressPath) ? readFileSync(addressPath, "utf8").trim() : "(no .address file)"}`);
  process.exit(1);
}

const key = generatePrivateKey();
const { address } = privateKeyToAccount(key);

// O_EXCL ("wx"): if anything created the file since the check above, fail
// rather than write over it.
const fd = openSync(keyPath, "wx", 0o600);
try {
  writeSync(fd, `${key}\n`);
} finally {
  closeSync(fd);
}

// Read it back and prove it is the key for the address we are about to show.
const stored = readFileSync(keyPath, "utf8").trim() as `0x${string}`;
if (privateKeyToAccount(stored).address !== address) {
  console.error("the stored key does not match the generated address; delete the file and run again");
  process.exit(1);
}
if ((statSync(keyPath).mode & 0o777) !== 0o600) {
  console.error(`${keyPath} is not 0600`);
  process.exit(1);
}
writeFileSync(addressPath, `${address}\n`, { mode: 0o644 });

console.log(`${role}: ${address}`);
