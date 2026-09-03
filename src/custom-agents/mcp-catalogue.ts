/**
 * The Skipper MCP tools a custom agent can be granted, grouped for the config
 * page.
 *
 * This is a presentation catalogue, not the source of truth. What an agent
 * actually gets is the intersection of its enabled list with what the daemon
 * offers that session (`mcp/tools.ts` decides root vs delegated), so a stale
 * entry here can only ever fail to appear — it can never grant anything. A test
 * asserts every id below is a tool the daemon really registers, which is what
 * keeps the two from drifting.
 */
export interface McpToolSpec {
  name: string;
  label: string;
  description: string;
  /** Registered on root sessions only — a delegated child never receives it. */
  rootOnly?: boolean;
}

export interface McpToolGroup {
  key: string;
  label: string;
  /** Why an operator would grant this group. */
  hint: string;
  tools: McpToolSpec[];
}

export const MCP_TOOL_GROUPS: McpToolGroup[] = [
  {
    key: "knowledge",
    label: "Notes and artifacts",
    hint: "Leave findings for the next agent, and write documents that outlive the run.",
    tools: [
      { name: "create_note", label: "Create note", description: "Leave a note for the next agent on this task." },
      { name: "list_notes", label: "List notes", description: "Read notes left by earlier agents." },
      { name: "create_artifact", label: "Create artifact", description: "Write a versioned document on the task." },
      { name: "create_file_artifact", label: "Attach file artifact", description: "Attach a file on disk (screenshot, PDF, archive) to the task." },
      { name: "get_artifact", label: "Get artifact", description: "Read a specific artifact version." },
      { name: "list_artifacts", label: "List artifacts", description: "See which artifacts exist on the task." },
    ],
  },
  {
    key: "operator",
    label: "Talking to the operator",
    hint: "Escalate blocks a run until a human answers; a message never interrupts.",
    tools: [
      { name: "escalate", label: "Escalate", description: "Ask the operator a question and wait for an answer." },
      { name: "check_escalation", label: "Check escalation", description: "Poll for the answer to an escalation." },
      { name: "post_message", label: "Post message", description: "Post a short plain-language progress update for the operator." },
    ],
  },
  {
    key: "delegation",
    label: "Delegation",
    hint: "Hand work to other agents on the team and collect their results.",
    tools: [
      { name: "delegate", label: "Delegate", description: "Give one piece of work to another agent on the team." },
      { name: "delegate_batch", label: "Delegate batch", description: "Fan work out to several agents at once." },
      { name: "delegate_resume", label: "Resume delegation", description: "Send follow-up work to an agent already used." },
      { name: "check_delegation", label: "Check delegation", description: "Poll one delegation for its result." },
      { name: "check_delegation_group", label: "Check delegation group", description: "Poll a batch for its results." },
      { name: "list_delegations", label: "List delegations", description: "See this task's delegations and their state." },
    ],
  },
  {
    key: "phase",
    label: "Phase and task control",
    hint: "Only the root agent on a task receives these. A delegated agent is refused.",
    tools: [
      { name: "complete_phase", label: "Complete phase", description: "Advance the task to the next phase.", rootOnly: true },
      { name: "regress_phase", label: "Regress phase", description: "Send the task back to an earlier phase.", rootOnly: true },
      { name: "complete_task", label: "Complete task", description: "Finish the task.", rootOnly: true },
    ],
  },
  {
    key: "global_store",
    label: "Global store",
    hint: "Shared key/value state across tasks. Grant only when a task template asks for it.",
    tools: [
      { name: "set_global_value", label: "Set value", description: "Write a value to the cross-task store." },
      { name: "get_global_value", label: "Get value", description: "Read a value from the cross-task store." },
      { name: "query_global_store", label: "Query store", description: "Search the cross-task store." },
      { name: "delete_global_value", label: "Delete value", description: "Remove a value from the cross-task store." },
    ],
  },
  {
    key: "slack",
    label: "Slack",
    hint: "Root agents only, and only when Slack is configured and enabled for the task's team.",
    tools: [
      { name: "slack_send_message", label: "Send message", description: "Post to a Slack channel as the Skipper app.", rootOnly: true },
      { name: "slack_send_dm", label: "Send DM", description: "Direct-message a Slack user as the Skipper app.", rootOnly: true },
      { name: "slack_read_channel", label: "Read channel", description: "Read recent messages from a Slack channel.", rootOnly: true },
    ],
  },
];

export function allMcpToolNames(): string[] {
  return MCP_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name));
}
