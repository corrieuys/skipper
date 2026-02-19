import { AgentTypeOption, buildAgentTypeModelMap } from "./components";


export function agentTypeModelScript(agentTypes: AgentTypeOption[]): string {
    const typeModelsMap = buildAgentTypeModelMap(agentTypes);
    return `<script>
    window.__agentTypeModels = ${JSON.stringify(typeModelsMap)};
    function updateAgentModels(suffix, type) {
      var sel = document.getElementById('agent-model-' + suffix);
      if (!sel) return;
      var models = (window.__agentTypeModels || {})[type] || [];
      var options = models.map(function(m) { return '<option value="' + m + '">' + m + '</option>'; });
      options.push('<option value="default">default</option>');
      sel.innerHTML = options.join('');
    }
  </script>`;
}
