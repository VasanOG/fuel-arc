/**
 * Encryption for third-party credentials held at rest.
 *
 * Everything secret in Fuel so far has lived in `.env` and been compared, never
 * stored: `FUEL_API_KEY` is hashed at boot, the Fireblocks key is a path into
 * gitignored `secrets/`. QuickBooks breaks that pattern — OAuth gives us tokens
 * we must KEEP, and Intuit rotates the refresh token roughly daily while
 * force-expiring its predecessor, so they have to survive a restart. That means
 * writing a live credential into `fuel.db`.
 *
 * `fuel.db` is gitignored, but "not in git" is not the same as "protected". A
 * database file gets copied to a laptop for debugging, attached to a bug
 * report, or snapshotted into a backup — the `fuel.db.bak-*` files in this repo
 * root are exactly that habit. A stolen refresh token is a standing grant to
 * read and write a customer's books until someone notices and revokes it.
 * Encrypting at rest means a leaked database file is not a leaked accounting
 * integration.
 *
 * AES-256-GCM, so ciphertext is authenticated: tampering with a stored token is
 * detected on decrypt rather than producing garbage that gets sent to Intuit as
 * a bearer token.
 *
 * What this does NOT defend against, stated plainly so nobody assumes more: the
 * key lives in the same `.env` as everything else, so an attacker who has both
 * the database and the environment has the tokens. It raises the bar from one
 * artifact to two, which is the realistic threat here (a copied database),
 * not a claim of key-management sophistication.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { requireEnv } from "./env.js";

/** AES-256 needs exactly 32 bytes; GCM's standard nonce is 12. */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Read once at boot so a missing or malformed key fails the server immediately,
 * the same way FUEL_API_KEY and X402_PAY_TO already do. A key discovered to be
 * wrong at the moment a token needs decrypting would surface as a broken
 * integration long after the mistake, with no obvious cause.
 */
function loadKey(): Buffer {
  const raw = requireEnv("FUEL_TOKEN_ENCRYPTION_KEY").trim();

  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      "FUEL_TOKEN_ENCRYPTION_KEY must be hex. Generate one with: openssl rand -hex 32",
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `FUEL_TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex characters), ` +
        `got ${key.length}. Generate one with: openssl rand -hex 32`,
    );
  }
  // A key of all zeroes is what you get from `printf '0%.0s' {1..64}` or a
  // placeholder someone forgot to replace. It encrypts fine, which is the
  // problem: it would look like it worked.
  if (timingSafeEqual(key, Buffer.alloc(KEY_BYTES))) {
    throw new Error(
      "FUEL_TOKEN_ENCRYPTION_KEY is all zeroes — that is a placeholder, not a key. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  return key;
}

let cachedKey: Buffer | null = null;

/**
 * Lazy rather than module-level, unlike auth.ts.
 *
 * Deliberate: `src/db/index.ts` is imported by every script in this repo, and
 * several of them (verify-rollup, the Fireblocks scripts) have no business
 * needing a QuickBooks key to run. Loading eagerly here would make an unrelated
 * script fail on a missing key for an integration it never touches. The key is
 * still validated before any token is written or read, which is the moment that
 * matters.
 */
function key(): Buffer {
  if (cachedKey === null) cachedKey = loadKey();
  return cachedKey;
}

/**
 * Plaintext -> `v1.<iv>.<ciphertext>.<tag>`, all base64url.
 *
 * The version prefix is not decoration. Key rotation and algorithm changes are
 * both foreseeable, and a stored blob with no version is one that cannot be
 * migrated without guessing at its format. Costs four characters now.
 *
 * A fresh random IV per call means encrypting the same token twice produces
 * different ciphertext — so the database never reveals that two rows hold the
 * same value, and GCM's security assumption (never reuse an IV with one key)
 * holds.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/**
 * The inverse. Throws on a wrong key, a truncated blob, or any tampering — GCM
 * authenticates, so a modified ciphertext fails rather than decrypting to
 * something plausible.
 *
 * The error deliberately says nothing about the value it failed on. An error
 * message is the easiest way for a secret to end up in a log file, and this
 * module's whole purpose is defeated if the token appears in the stack trace
 * generated while failing to decrypt it.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Stored secret is not in the expected v1 format");
  }
  const [, ivPart, ciphertextPart, tagPart] = parts;

  const iv = Buffer.from(ivPart!, "base64url");
  const ciphertext = Buffer.from(ciphertextPart!, "base64url");
  const tag = Buffer.from(tagPart!, "base64url");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Stored secret has a malformed IV or authentication tag");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Swallowing the underlying error is intentional — see the docblock.
    throw new Error(
      "Could not decrypt a stored secret: wrong FUEL_TOKEN_ENCRYPTION_KEY, or the value was altered",
    );
  }
}

/**
 * What a secret may look like in a log, an error, or an API response: nothing
 * useful.
 *
 * Returns a fixed marker rather than a prefix like `abc123…`. A prefix feels
 * harmless and is genuinely useful for debugging, but OAuth tokens are not
 * uniformly random — Intuit's carry structured prefixes — and any disclosed
 * bytes shrink the search space of a credential that grants access to a
 * customer's books. There is nothing here worth that trade: the id of the
 * connection row identifies it perfectly well for support purposes.
 */
export function redactSecret(): string {
  return "[redacted]";
}
