import type { AgentDefinition } from "./store";

// Built-in infra agent: "skipper" (root orchestrator, implicit entrypoint of
// every team). Registered at boot. The model here is a last-resort fallback;
// the operator's provider/model choices from the config UI live in runtime
// app_settings (model-settings).

export const BUILTIN_INFRA_AGENTS: AgentDefinition[] = [
  {
    id: "skipper",
    name: "Skipper",
    type: "claude-code",
    model: "claude-opus-4-8",
    capabilities: ["delegation", "orchestration"],
  },
];
