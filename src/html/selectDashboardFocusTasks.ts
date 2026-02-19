import { parseDashboardTaskTime } from "./components";


export function selectDashboardFocusTasks(
    tasks: {
        id: string;
        title: string;
        status: string;
        task_type?: string;
        description?: string | null;
        created_at?: string;
    }[]
): {
    id: string;
    title: string;
    status: string;
    task_type?: string;
    description?: string | null;
    created_at?: string;
}[] {
    const active = tasks
        .filter((t) => t.status === "running" || t.status === "approved")
        .sort((a, b) => {
            const rank = (status: string) => status === "running" ? 0 : status === "approved" ? 1 : 2;
            const byStatus = rank(a.status) - rank(b.status);
            if (byStatus !== 0) return byStatus;
            return (
                parseDashboardTaskTime(b.created_at) -
                parseDashboardTaskTime(a.created_at)
            );
        });

    if (active.length > 0) return active;

    const latestCompleted = tasks
        .filter((t) => t.status === "completed")
        .sort(
            (a, b) => parseDashboardTaskTime(b.created_at) -
                parseDashboardTaskTime(a.created_at)
        )[0];

    return latestCompleted ? [latestCompleted] : [];
}
