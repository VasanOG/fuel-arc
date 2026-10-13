/**
 * What an earning endpoint is called in the books, and what it may not be
 * called.
 *
 * WHY THIS IS ITS OWN MODULE WITH NO DATABASE IMPORT. The rule was originally
 * in db/earning-endpoints.ts, whose doc-comment described it as "the single
 * gate every label passes, whoever is setting it". That was false: the label
 * backfill in db/index.ts derived a label from `origin_url` and wrote it
 * straight to the row, and it could not have called the gate without creating
 * an import cycle — index.ts owns `db`, and earning-endpoints.ts imports it.
 *
 * A security review found the hole. The fix is not to remember to call the
 * function; it is to put the rule somewhere every write path CAN reach, so the
 * claim is true by construction rather than by discipline. Nothing here touches
 * the database, the network or the clock.
 */

/**
 * What a revenue line's counterparty is called when Fuel cannot name the
 * endpoint.
 *
 * `receipts.endpoint_id` is nullable, `posting_lines.counterparty` is NOT NULL,
 * and something has to bridge that. No application path produces a NULL today —
 * there is no delete route for an endpoint, and the foreign key's default
 * NO ACTION would refuse one — but "cannot happen today" is a fact about the
 * current code, and verify-migration proves direct SQL can write one in a
 * single statement.
 *
 * REFUSING WOULD BE WORSE THAN LABELLING. The check would sit inside
 * runPosting's transaction, so one unattributable row would stop posting for
 * every company, spend included. Instead the row posts under this name and
 * verifyPostingIntegrity reports it, which is visible rather than silent and
 * costs nobody their books.
 *
 * REVIEW: the claim to attack is that this string can never be an operator's
 * label — if it can, an operator can mask the integrity flag by naming an
 * endpoint after it. assertUsableLabel refuses it by exact match, which is why
 * that refusal is load-bearing and not tidiness.
 */
export const UNATTRIBUTED_COUNTERPARTY = "(unattributed endpoint)";

/**
 * The bound, matching QuickBooks' own field limit.
 *
 * `QBO_ACCOUNT_FIELD_MAX` is 100 for the same reason and was set after an
 * over-long description cost a live setup run to diagnose — Intuit's refusal
 * names neither the field nor the length.
 */
export const LABEL_MAX_LENGTH = 100;

/**
 * Anything shaped like an address or a hash.
 *
 * ADR 0006 keeps crypto identifiers out of accounting output, and every other
 * text field that reaches postings.csv is either Fuel-derived (a payment id) or
 * URL-derived (vendorFromResourceUrl). The label is the first one a person
 * types, so it is the first that could carry `0x8ba1f1...` into an accountant's
 * file. CSV escaping does not help here: the value is not malformed, it is the
 * wrong KIND of value.
 *
 * THE SECOND ALTERNATIVE MATTERS AS MUCH AS THE FIRST. A bare run of 32+ hex
 * characters is an address or hash with the `0x` filed off — and it is also
 * exactly what an origin path carrying an MD5, a git SHA or a hyphen-less UUID
 * looks like, which is how the migration bypass reached a real accounting
 * document rather than staying theoretical.
 *
 * DELIBERATELY NARROW OTHERWISE. It matches those two shapes, not the
 * vocabulary verify-api's NO_CRYPTO list bans from responses — "chain" belongs
 * in "Supply Chain API", and refusing that would be Fuel telling a customer
 * what their own product is called.
 */
const HEX_IDENTIFIER = /0x[0-9a-fA-F]{4,}|[0-9a-fA-F]{32,}/;

export class InvalidLabelError extends Error {
  constructor(reason: string) {
    super(`That endpoint name will not work: ${reason}.`);
    this.name = "InvalidLabelError";
  }
}

/**
 * The single gate every label passes, whoever is setting it — now true.
 *
 * Callers: `registerEndpoint` and `setLabel` in db/earning-endpoints.ts, and
 * the backfill in db/index.ts. If a fourth write path appears it must call this
 * too, and the reason it can is that this module imports nothing.
 */
export function assertUsableLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) throw new InvalidLabelError("it is empty");
  if (trimmed.length > LABEL_MAX_LENGTH) {
    throw new InvalidLabelError(
      `it is ${trimmed.length} characters and the limit is ${LABEL_MAX_LENGTH}`,
    );
  }
  if (trimmed.toLowerCase() === UNATTRIBUTED_COUNTERPARTY) {
    throw new InvalidLabelError("that name is reserved for endpoints Fuel cannot identify");
  }
  if (HEX_IDENTIFIER.test(trimmed)) {
    throw new InvalidLabelError(
      "it contains something shaped like an address or a transaction hash, and this name " +
        "is written into accounting exports",
    );
  }
  // Control characters would survive CSV escaping and reach a spreadsheet as
  // invisible content in a column an accountant reconciles against.
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new InvalidLabelError("it contains control characters");
  }
  return trimmed;
}

/**
 * The label to use when one has to be derived from an origin URL.
 *
 * Shared by registration and by the backfill so a registered endpoint and a
 * migrated one genuinely read alike — an earlier version claimed that kinship
 * while the two paths diverged on the only check that mattered.
 *
 * A derived name that the gate refuses falls back to the generic one rather
 * than being written anyway. An operator renames it to whatever their books
 * should say; Fuel does not smuggle a URL through a door it has locked.
 */
export function deriveLabel(originUrl: string, suffix = ""): string {
  const room = LABEL_MAX_LENGTH - suffix.length;
  let base: string;
  try {
    const url = new URL(originUrl);
    base = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    base = "endpoint";
  }
  const candidate = `${base.slice(0, room).trim() || "endpoint"}${suffix}`;
  try {
    return assertUsableLabel(candidate);
  } catch {
    return `endpoint${suffix}`;
  }
}
