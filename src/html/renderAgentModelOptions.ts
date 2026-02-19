import { AgentTypeOption, parseAvailableModels, escapeHtml } from "./components";


export function renderAgentModelOptions(
    agentTypes: AgentTypeOption[],
    selectedType: string,
    selectedModel: string
): string {
    const current = agentTypes.find((t) => t.name === selectedType);
    const models = current ? parseAvailableModels(current.available_models) : [];
    const all = [...models, "default"];
    const unique = Array.from(new Set(all));
    return unique
        .map(
            (m) => `<option value="${escapeHtml(m)}"${m === selectedModel ? " selected" : ""}>${escapeHtml(m)}</option>`
        )
        .join("");
}
