# 0005 — Dashboard shows wallet addresses, as a temporary, explicit exception

## Decision
The Phase 1 dashboard displays each agent's wallet address (truncated,
copy-on-click, full value in the tooltip). This is a deliberate, temporary
exception to the no-crypto-surface rule in `/docs/architecture.md` and
CLAUDE.md ("no crypto terms ... ever appear in the product") — not a reversal
of that rule and not a precedent for future UI.

## Why
The dashboard in its current form is an internal operator tool, not a
customer-facing product surface. Debugging and funding agent wallets
(checking a balance on a block explorer, sending faucet funds to the right
address, matching an on-chain tx to an agent) currently requires the raw
address, and there is no other product surface yet where that need is met
some other way.

## Scope of the exception
Applies only to the current internal dashboard, used by us to operate Fuel
sandbox agents. It does not extend to any other surface, and it does not mean
addresses are cleared for display generally.

## Revisit when
Before anything resembling a customer-facing version of the dashboard exists.
At that point, decide whether the operator-facing address view stays as a
separate internal tool (e.g. gated behind different auth/roles) while the
customer-facing surface stays address-free, or whether the address need goes
away entirely (agent name plus a Fuel-internal ID may be enough once
funding/debugging flows don't require a human to read a raw address).

---

## Closed — 2026-08-26 (Phase 5, Slice 5A-1)

The revisit trigger above fired. Phase 5 turns the dashboard into a product
surface with an application shell and an information architecture, which is
"anything resembling a customer-facing version of the dashboard".

Of the two options this ADR named, neither survived contact: the address need
did not go away, but it stopped being a *product* need. Funding and debugging a
sandbox agent is operator work done from the repo's own scripts, which read the
address from the API directly and never needed a screen for it. Keeping a column
in the product to serve a job the product was not doing was the whole mistake.

**The exception is closed, not narrowed.** Addresses are removed from every
dashboard surface. The API still returns the field, because it is real data
about a real account, and `src/` still uses it.

**A type is not a boundary, and assuming it was is the mistake this ADR should
be remembered for.** The first version of this change removed `walletAddress`
from the dashboard's `FuelAgent` type and claimed the compiler now enforced its
absence. It did not. A TypeScript annotation is erased at build time: it stops a
field being *rendered*, because reading it fails the build, but it does nothing
about the field being *transmitted*. `listAgents()` still did `return
res.json()`, handing the whole upstream object to a Server Component, which
passed it as a prop to a Client Component — and Next.js serialises the object it
is actually given into the page. **Five addresses were arriving in the browser
with nothing on screen showing them.** Caught by the security review, confirmed
by grepping the delivered HTML.

What actually enforces it is an explicit field pick at the network boundary
(`toAgentCore` in `dashboard/lib/fuel.ts`), written as an allowlist rather than
a delete so a field the API adds later must be named before it can reach the
browser.

**What replaces the check** — two checks, because there turned out to be two
questions. `scripts/qa-dashboard.ts` runs both against every route at every
breakpoint:

1. *What can a person see?* The terminology list `verify-rollup.ts` and
   `verify-quickbooks.ts` already ban, run over rendered text. Rendered text
   rather than source, because source contains `token` in design-token naming
   and `chain` in a CSS class, and a check that cries wolf is a check people
   learn to skip.
2. *What leaves the server?* An address-shaped pattern over the delivered HTML,
   including the framework payload. This is the check that would have caught the
   leak above, and an innerText check never would have. It is a precise pattern
   rather than the word list because the full HTML legitimately contains hashed
   class names the word list would trip over.

Both were confirmed to fail against the broken version before being trusted.

**One deliberate difference from the existing lists**: they ban a bare `eip`,
which is safe against a JSON payload but not against prose, because "receipt"
contains it. The rendered check looks for `eip155`.

Superseded by nothing; this ADR is simply complete. The no-crypto-surface rule
in `/docs/architecture.md` and CLAUDE.md now applies to the dashboard without
exception.
