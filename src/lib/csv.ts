/**
 * RFC 4180 CSV serialization, with the spreadsheet-specific hazards handled.
 *
 * Hand-rolled rather than pulled from npm: this is ~30 lines of real logic, and
 * a dependency that renders money for an accountant is a dependency worth not
 * having.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than
 * text. A cell beginning with any of these is executed on open by Excel,
 * Google Sheets and LibreOffice.
 *
 * This matters here because agent names are operator-supplied and land
 * directly in a cell. An agent named `=HYPERLINK("http://evil","Click")` — or
 * a resource URL crafted to start with one of these — becomes a live formula
 * in whatever machine opens the export, which for an accounting file is
 * somebody outside the company. This is CSV injection, and it is the reason
 * this module exists instead of a `.join(",")`.
 *
 * Tab and carriage return are included because leading whitespace is stripped
 * by some spreadsheet parsers before the formula check, which would otherwise
 * let "\t=1+1" through.
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/**
 * A plain decimal number, optionally negative. Nothing else.
 *
 * Anchored at both ends and allowing only digits, one optional decimal point
 * and one optional leading minus, so it can match a number and nothing that
 * could also be a formula: `-0.02` matches, `-1+cmd|' /C calc'!A0` does not,
 * and neither does anything containing a letter, operator, space or separator.
 * Keeping it this strict is what makes the exemption below safe.
 */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Neutralizes a value as spreadsheet text.
 *
 * The leading apostrophe is the standard defusal: spreadsheets read it as
 * "treat the rest as literal text" and do not display it. It is applied before
 * quoting, so it ends up inside the quoted field where the parser sees it.
 *
 * NEGATIVE NUMBERS ARE EXEMPT, and this is a correctness fix rather than a
 * loosening. This function used to assume no amount could begin with `-`, which
 * held only because nothing in the system produced a negative amount. The
 * accounting rollup now does: a reclassification credit, released from suspense
 * when an unreconciled payment finally settles, is a genuinely negative posting
 * line. Defusing it wrote `'-0.02` into the amount column, which parses as text
 * rather than as money — so the one row that releases a suspense balance became
 * unreadable to the importer it was written for. Verified before the fix: the
 * cell round-tripped as NaN.
 *
 * The exemption is safe because PLAIN_NUMBER cannot match anything a
 * spreadsheet would execute. A cell of `-0.02` evaluates to negative two
 * hundredths; there is no payload it could carry. Every other `-`-leading
 * value — an agent name, a vendor host, anything operator-supplied — still
 * gets the apostrophe, because none of those match a bare number.
 */
function defuseFormula(value: string): string {
  if (PLAIN_NUMBER.test(value)) return value;
  return FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix)) ? `'${value}` : value;
}

/** Quotes a field if it needs it, doubling any embedded quotes. */
function escapeField(value: string): string {
  const defused = defuseFormula(value);
  // A leading or trailing space is also quoted: unquoted, some parsers trim it,
  // which silently changes a value.
  const needsQuotes = /[",\r\n]/.test(defused) || defused !== defused.trim();
  return needsQuotes ? `"${defused.replace(/"/g, '""')}"` : defused;
}

/**
 * Rows to an RFC 4180 document.
 *
 * CRLF line endings per the spec, which is also what Excel expects. The UTF-8
 * BOM is prepended because Excel on Windows otherwise decodes the file as the
 * system codepage and mangles any non-ASCII agent name.
 */
export function toCsv(header: string[], rows: string[][]): string {
  const BOM = "﻿";
  const lines = [header, ...rows].map((row) => row.map(escapeField).join(","));
  // Trailing CRLF: the spec allows the last record to end with one, and its
  // absence makes some tools drop the final row.
  return BOM + lines.join("\r\n") + "\r\n";
}
