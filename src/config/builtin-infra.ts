import type { AgentDefinition } from "./store";

// Built-in infra agents: "skipper" (root orchestrator, implicit entrypoint of
// every team) and "chat-skipper" (conversational agent). Registered at boot.
// The models here are last-resort fallbacks; the operator's provider/model
// choices from the config UI live in runtime app_settings (model-settings).

export const BUILTIN_INFRA_AGENTS: AgentDefinition[] = [
  {
    id: "skipper",
    name: "Skipper",
    type: "claude-code",
    model: "claude-opus-4-8",
    capabilities: ["delegation", "orchestration"],
  },
  {
    id: "chat-skipper",
    name: "Chat Skipper",
    type: "claude-code",
    model: "claude-opus-4-6",
    instruction:
      "You are a conversational Skipper assistant for the Skipper multi-agent orchestration system. Help the user manage tasks, agents, and teams through natural conversation. Respond in html assuming that the text is inside a div.",
    capabilities: [],
  },
];
