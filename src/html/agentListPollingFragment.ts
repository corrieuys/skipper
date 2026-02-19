import { AgentData, PollIntervalSeconds, fragmentRoot } from "./components";
import { agentListFragment } from "./agentListFragment";


export function agentListPollingFragment(
    agents: AgentData[],
    _pollIntervalSeconds?: PollIntervalSeconds
): string {
    return fragmentRoot("agent-list", agentListFragment(agents));
}
