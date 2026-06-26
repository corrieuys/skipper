import type { AgentDefinition, TeamDefinition } from "./store";

// Built-in realtime config: the "Real Time" team plus its librarian and
// summarizer agents, registered into the config store at boot.
//   - getRealtimeTeamId() finds the team by name "real time" (or configured id)
//   - the summarizer is resolved by the id "realtime-summarizer"
//     (src/html/realtime-components.ts)

export const REALTIME_TEAM_ID = "b4a6b06b-ff1c-4d10-8ff2-4ced31d018e9";
const LIBRARIAN_AGENT_ID = "123fe123-ac53-46bb-b1b6-2a2a08122b8e";
export const REALTIME_SUMMARIZER_AGENT_ID = "realtime-summarizer";

export const BUILTIN_REALTIME_AGENTS: AgentDefinition[] = [
  {
    id: LIBRARIAN_AGENT_ID,
    name: "Librarian",
    type: "claude-code",
    model: "claude-opus-4-6",
    instruction:
      "Your job is to do an analysis based on the input, in the appropriate codebase. Your output should be an artifact with findings. This will depend on the task instructions. You should not make any other file changes. You should optimize your effort to not go on too many tangents. If you cannot find relevant information, do not create any notes or artifacts. Take direct user input as high priority instructions or comments.",
    capabilities: ["business rules and code analyst"],
  },
  {
    id: REALTIME_SUMMARIZER_AGENT_ID,
    name: "Summarizer",
    type: "claude-code",
    model: "claude-sonnet-4-6",
    instruction:
      "You are a summarization specialist. You receive transcribed audio segments and produce concise, accurate summaries that preserve key details, decisions, action items, and context. Output your summary as plain text. Focus on what was said, who said it, and any decisions or commitments made.",
    capabilities: ["summarization"],
  },
];

export const BUILTIN_REALTIME_TEAMS: TeamDefinition[] = [
  {
    id: REALTIME_TEAM_ID,
    name: "Real Time",
    goal: "Rapid exploration and synthesis anchored by librarian analysis.",
    entrypoint_agent_id: "skipper",
    phases: [],
    members: [
      { agent_id: LIBRARIAN_AGENT_ID, role: "librarian", level: 1, parent_agent_id: null },
      { agent_id: "skipper", role: "lead", level: 0, parent_agent_id: null },
    ],
  },
];
