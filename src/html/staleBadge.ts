
export function staleBadge(updatedAt: string): string {
    const updated = new Date(
        updatedAt.includes("T") ? updatedAt : updatedAt.replace(" ", "T") + "Z"
    );
    const ageMs = Date.now() - updated.getTime();
    const ageMin = ageMs / 60000;

    if (ageMin > 10) {
        return `<span class="badge badge-error" title="Last updated ${Math.round(ageMin)}m ago">STALE</span>`;
    }
    if (ageMin > 5) {
        return `<span class="badge badge-stopped" title="Last updated ${Math.round(ageMin)}m ago">aging</span>`;
    }
    return "";
}
