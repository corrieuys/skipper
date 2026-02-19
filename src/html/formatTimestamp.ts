import { escapeHtml } from "./components";
import { parseTimestamp } from "./parseTimestamp";


export function formatTimestamp(isoString: string): string {
    const date = parseTimestamp(isoString);
    if (isNaN(date.getTime())) return escapeHtml(isoString);

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const absDiffMs = Math.abs(diffMs);
    const diffSec = Math.floor(diffMs / 1000);
    const absDiffSec = Math.floor(absDiffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const absDiffMin = Math.floor(absDiffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const absDiffHr = Math.floor(absDiffMin / 60);
    const diffDay = Math.floor(diffHr / 24);
    const absDiffDay = Math.floor(absDiffHr / 24);

    let relative: string;
    if (Math.abs(diffSec) < 60) {
        relative = "just now";
    } else if (diffMs >= 0) {
        if (diffMin < 60) relative = `${diffMin}m ago`;
        else if (diffHr < 10) {
            const hours = diffHr;
            const minutes = diffMin % 60;
            relative = `${hours}h ${minutes}m ago`;
        } else if (diffHr < 24) relative = `${diffHr}h ago`;
        else if (diffDay < 30) relative = `${diffDay}d ago`;
        else relative = date.toLocaleDateString();
    } else {
        if (absDiffMin < 60) relative = `in ${absDiffMin}m`;
        else if (absDiffHr < 10) {
            const hours = absDiffHr;
            const minutes = absDiffMin % 60;
            relative = `in ${hours}h ${minutes}m`;
        } else if (absDiffHr < 24) relative = `in ${absDiffHr}h`;
        else if (absDiffDay < 30) relative = `in ${absDiffDay}d`;
        else relative = date.toLocaleDateString();
    }

    return `<span title="${escapeHtml(date.toLocaleString())}" data-ts="${date.getTime()}">${relative}</span>`;
}
