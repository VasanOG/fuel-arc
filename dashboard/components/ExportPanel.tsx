/**
 * The accounting export control.
 *
 * A plain HTML form with method="get", deliberately: the browser navigates to
 * the route handler, which answers with Content-Disposition: attachment, so the
 * file downloads without leaving the page and without a line of client
 * JavaScript. There is no state to manage here, so there is no reason for this
 * to be a Client Component.
 *
 * Empty date fields submit as empty strings, which the route handler drops —
 * so "no dates" means "everything", which is what an operator exporting for the
 * first time wants.
 */
export function ExportPanel() {
  return (
    <div className="export-panel">
      <form method="get" action="/api/exports/transactions">
        <label>
          From
          <input type="date" name="from" className="date-input" />
        </label>
        <label>
          To
          <input type="date" name="to" className="date-input" />
        </label>
        <label>
          Rows
          <select name="include" className="date-input" defaultValue="ledger">
            <option value="ledger">Payments only</option>
            <option value="all">Include refused and failed</option>
          </select>
        </label>
        <button type="submit">Download CSV</button>
      </form>
      <p className="export-note">
        One row per payment, in dollars. Refused payments are left out by default — nothing was
        charged for them.
      </p>
    </div>
  );
}
