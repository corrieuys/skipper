import type { ForensicsAgentInstance } from "./components";

// --- Forensics Render Functions ---

export function computeDisplayStatus(instance: ForensicsAgentInstance): {
    processOutcome: string;
    workflowState: string;
} {
    let processOutcome: string;
    if (instance.exit_code != null) {
        processOutcome =
            instance.exit_code === 0 ? "exited:0" : `killed:${instance.exit_code}`;
    } else if (instance.process_pid != null) {
        processOutcome = "alive";
    } else {
        processOutcome = "no-process";
    }

    let workflowState: string;
    if (instance.status === "running" && instance.exit_code != null) {
        workflowState = "stale-running";
    } else if (instance.status === "waiting_delegation") {
        workflowState = "blocked";
    } else if (instance.status === "completed" &&
        instance.exit_code != null &&
        instance.exit_code !== 0) {
        workflowState = "force-completed";
    } else {
        workflowState = instance.status;
    }

    return { processOutcome, workflowState };
}
