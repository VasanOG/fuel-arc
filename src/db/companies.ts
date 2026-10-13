/**
 * The top of the budget hierarchy.
 *
 * A company's cap is the ceiling on everything spent beneath it, across every
 * team and every agent. It replaces the old single-row `global_cap` table —
 * same ceiling, now an entity with a name and an owner rather than a magic
 * row with id = 1.
 *
 * It is not the sum of its teams' caps, and nothing validates it against
 * them: teams can be configured to add up to more than the company allows,
 * in the same way a company card limit is not the sum of every employee's
 * limit. What it bounds is money that actually moved.
 */
import { randomUUID } from "node:crypto";
import { newHandle } from "../lib/handles.js";
import { db } from "./index.js";

export interface Company {
  id: string;
  name: string;
  /**
   * How a person names this company at sign-in (src/lib/handles.ts, ADR 0018).
   * Null only for a row inserted without one, which boot fills in; a company
   * with no handle cannot be signed into, which fails closed.
   */
  handle: string | null;
  spendCapBaseUnits: bigint;
  createdAt: string;
}

interface CompanyRow {
  id: string;
  name: string;
  handle: string | null;
  spend_cap_base_units: number | bigint;
  created_at: string;
}

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle ?? null,
    spendCapBaseUnits: BigInt(row.spend_cap_base_units),
    createdAt: row.created_at,
  };
}

/** How many random suffixes to try before giving up. A clash needs the same slug AND the same 4 of 31^4 draws. */
const HANDLE_ATTEMPTS = 8;

export function createCompany(params: { name: string; spendCapBaseUnits: bigint }): Company {
  const id = randomUUID();
  for (let attempt = 1; ; attempt++) {
    try {
      db.prepare(
        `INSERT INTO companies (id, name, handle, spend_cap_base_units, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, params.name, newHandle(params.name), params.spendCapBaseUnits, new Date().toISOString());
      return getCompanyUnscoped(id)!;
    } catch (error) {
      // Only the handle's own clash is retried, with a new random suffix.
      // Nothing else here can clash: names are not unique (ADR 0018).
      if (!/UNIQUE constraint failed: companies\.handle/.test((error as Error).message) || attempt >= HANDLE_ATTEMPTS) {
        throw error;
      }
    }
  }
}

export function getCompanyUnscoped(id: string): Company | null {
  const row = db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as CompanyRow | undefined;
  return row ? toCompany(row) : null;
}

export function listCompanies(): Company[] {
  const rows = db
    .prepare("SELECT * FROM companies ORDER BY created_at")
    .all() as unknown as CompanyRow[];
  return rows.map(toCompany);
}

export function setCompanySpendCap(id: string, spendCapBaseUnits: bigint): Company | null {
  db.prepare("UPDATE companies SET spend_cap_base_units = ? WHERE id = ?").run(
    spendCapBaseUnits,
    id,
  );
  return getCompanyUnscoped(id);
}

/**
 * The company the legacy FUEL_API_KEY / FUEL_AGENT_KEY credentials act for.
 *
 * REPLACES `getDefaultCompany()`, WHICH IS DELETED RATHER THAN RENAMED. That
 * function returned the oldest company. It did not fail when a second company
 * existed; it quietly served the first tenant's data to every caller, from 44
 * route sites. Deleting it is what turned every one of those sites into a
 * compile error instead of a silent wrong answer -- a function that exists
 * will be called.
 *
 * This one is deliberately narrow and deliberately awkward. It answers exactly
 * one question -- "whose company do the pre-signup credentials belong to?" --
 * from a binding recorded once in `bootstrap_company` (src/db/index.ts), and
 * its only legitimate callers are the credential resolver in src/lib/auth.ts
 * and operator scripts. A route that wants "the current company" asks the
 * request for it with `companyOf(req)`; scripts/verify-api.ts asserts no route
 * file calls this.
 *
 * Throws rather than falling back. A database holding several companies with
 * no recorded binding has no honest answer here, and inventing one is the bug
 * this replaces.
 */
export function bootstrapCompany(): Company {
  const row = db
    .prepare("SELECT company_id FROM bootstrap_company WHERE id = 1")
    .get() as { company_id: string } | undefined;
  if (!row) {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number };
    throw new Error(
      `No bootstrap company is recorded, and this database holds ${n} companies, so ` +
        "there is no unambiguous answer to which one FUEL_API_KEY and FUEL_AGENT_KEY act " +
        "for. Record it explicitly in the bootstrap_company table rather than letting Fuel guess.",
    );
  }
  const company = getCompanyUnscoped(row.company_id);
  if (!company) {
    throw new Error("The recorded bootstrap company no longer exists — the database was tampered with");
  }
  return company;
}
