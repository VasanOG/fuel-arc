import { listAgents, listTeams } from "@/lib/fuel";
import { AgentsRoster } from "@/components/AgentsRoster";
import { PageHeader } from "@/components/shell/PageHeader";

// An operator tool watching live spend; a cached copy would be a wrong answer.
export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  // Two reads, in parallel: the roster names each agent's team, and the team
  // names live on their own endpoint rather than being denormalised onto the
  // agent. One request each, not one per agent.
  const [agents, teams] = await Promise.all([listAgents(), listTeams()]);

  return (
    <>
      {/*
        The description was rewritten rather than appended to. "Spend authority
        is the ceiling it cannot pass" is still true of the cap and became
        incomplete about the AGENT the moment an agent could earn: a sentence
        describing only the spending half would quietly frame the earnings
        column as an afterthought. The clause about earning not raising the
        ceiling is the one ADR 0013 settled, said where an operator reads it.
      */}
      <PageHeader
        title="Agents"
        description="Every agent Fuel governs — what it may spend, and what it has earned. Spend authority is the ceiling it cannot pass without a person approving the payment that would break it; earning does not raise that ceiling."
      />
      <div className="panel">
        <AgentsRoster initialAgents={agents} teams={teams} />
      </div>
      <p className="note">
        Freezing an agent is available through the Fuel API but not from here yet — this page
        reports frozen state rather than offering to change it.
      </p>
    </>
  );
}
