import { parseDashboardTaskTime } from "./components";

interface FocusTaskRow {
    id: string;
    title: string;
    /** Stored status: draft | active | settled. */
    status: string;
    /** Derived presentation status when available (queued/working/idle/...). */
    display_status?: string;
    mode?: string;
    /** @deprecated compat mirror of `mode`. */
    task_type?: string;
    description?: string | null;
    created_at?: string;
}

export function selectDashboardFocusTasks(tasks: FocusTaskRow[]): FocusTaskRow[] {
    const display = (t: FocusTaskRow): string => t.display_status ?? t.status;
    const active = tasks
        .filter((t) => t.status === "active")
        .sort((a, b) => {
            const rank = (t: FocusTaskRow) => {
                switch (display(t)) {
                    case "working": return 0;
                    case "review": return 1;
                    case "blocked": return 1;
                    case "queued": return 2;
                    default: return 3;
                }
            };
            const byStatus = rank(a) - rank(b);
            if (byStatus !== 0) return byStatus;
            return (
                parseDashboardTaskTime(b.created_at) -
                parseDashboardTaskTime(a.created_at)
            );
        });

    if (active.length > 0) return active;

    const latestArchived = tasks
        .filter((t) => t.status === "settled")
        .sort(
            (a, b) => parseDashboardTaskTime(b.created_at) -
                parseDashboardTaskTime(a.created_at)
        )[0];

    return latestArchived ? [latestArchived] : [];
}
