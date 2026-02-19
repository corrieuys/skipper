/** Navbar escalation count badge — pushed to ALL connected clients */
export const FRAGMENT_ID = "sk-nav-escalation-count";

export function escalationCountFragment(count: number): string {
  if (count === 0) {
    return `<span id="${FRAGMENT_ID}"></span>`;
  }
  return `<span id="${FRAGMENT_ID}" class="sk-badge sk-badge--danger sk-badge--nav">${count}</span>`;
}
