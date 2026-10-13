/**
 * Creating an agent: the one place a custody resource and a Fuel row are made
 * together.
 *
 * THE ORDER IS THE CONTROL. Provisioning creates a real Fireblocks vault, and
 * nothing un-creates one, so every refusal that can be decided without custody
 * is decided before it:
 *
 *   1. Is the name free in this team?            -> refuse, no vault exists
 *   2. Is another request creating it right now? -> refuse, no vault exists
 *   3. Provision the vault, named after the agent's ID
 *   4. Write the row; the UNIQUE constraints are the last word
 *
 * WHY THE VAULT IS NAMED AFTER THE ID. `provisionAgentWallet` is idempotent by
 * vault name -- asked for a name that exists, it returns that vault. Named
 * after the agent's NAME, two agents called "researcher" in two companies
 * would silently share one vault. An id is minted here, fresh, for exactly one
 * agent, so the only vault a name lookup can ever re-find is this agent's own
 * (a retry after a crash between steps 3 and 4 re-finds it, which is the
 * idempotency still doing its job).
 *
 * Kept out of the route so the provisioner can be passed in: the verification
 * suites exercise every step here with a stub and never reach Fireblocks.
 */
import { randomUUID } from "node:crypto";
import { createAgent, getAgentInTeamByName, type Agent } from "../db/agents.js";
import { provisionAgentWallet, type ProvisionedWallet } from "../fireblocks/provision.js";

export type Provisioner = (vaultName: string) => Promise<ProvisionedWallet>;

/** The name is already used in this team, or is being created in it right now. */
export class AgentNameTakenError extends Error {
  constructor() {
    super("an agent with this name already exists in this team");
    this.name = "AgentNameTakenError";
  }
}

/**
 * The vault a provisioner returned already belongs to another agent.
 *
 * Should be impossible with id-derived vault names, which is exactly why it is
 * its own error and not folded into a 409: it means custody and Fuel disagree
 * about who holds what, and an operator needs to look.
 */
export class VaultAlreadyHeldError extends Error {
  constructor(readonly vaultAccountId: string) {
    super("the account provisioned for this agent is already assigned to another agent");
    this.name = "VaultAlreadyHeldError";
  }
}

/** The vault name for an agent. Derived from the id alone -- never the name. */
export function vaultNameFor(agentId: string): string {
  return `fuel-agent-${agentId}`;
}

/**
 * (team, name) pairs with a creation in flight in THIS process.
 *
 * Step 1 alone has a gap: two requests for the same name both pass the lookup,
 * both `await` provisioning, and both create a vault before either writes a
 * row. JavaScript runs the check-and-add below without interleaving, so the
 * second request is refused before its own await. Across processes the UNIQUE
 * constraint still decides -- this only stops the common case from costing a
 * vault.
 */
const inFlight = new Set<string>();

export async function createAgentWithCustody(
  params: { name: string; teamId: string; spendCapBaseUnits: bigint },
  provision: Provisioner = provisionAgentWallet,
): Promise<Agent> {
  const { name, teamId, spendCapBaseUnits } = params;
  const key = JSON.stringify([teamId, name]);

  if (inFlight.has(key) || getAgentInTeamByName(teamId, name)) {
    throw new AgentNameTakenError();
  }
  inFlight.add(key);

  try {
    const id = randomUUID();
    const wallet = await provision(vaultNameFor(id));

    try {
      return createAgent({
        id,
        name,
        teamId,
        fireblocksVaultId: wallet.vaultAccountId,
        address: wallet.address,
        spendCapBaseUnits,
      });
    } catch (error) {
      const message = (error as Error).message ?? "";
      if (/UNIQUE constraint failed: agents\.fireblocks_vault_id/.test(message)) {
        console.error(
          `[agents] CUSTODY CONFLICT: provisioning for new agent ${id} returned vault ` +
            `${wallet.vaultAccountId}, which another agent already holds. No agent was written.`,
        );
        throw new VaultAlreadyHeldError(wallet.vaultAccountId);
      }
      if (/UNIQUE constraint failed: agents\.team_id, agents\.name/.test(message)) {
        // Lost a race another process won. The vault just created is named
        // after an id no row will ever carry, so nothing can re-find or use it,
        // but it exists at Fireblocks and should be archived by hand.
        console.error(
          `[agents] ORPHANED VAULT: ${wallet.vaultAccountId} (${vaultNameFor(id)}) was provisioned ` +
            `for a name another request created first. No agent holds it.`,
        );
        throw new AgentNameTakenError();
      }
      throw error;
    }
  } finally {
    inFlight.delete(key);
  }
}
