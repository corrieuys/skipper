export const FRAGMENT_ID = "sk-escalation-bar";

export function escalationBarPanel(count: number): string {
  if (count === 0) {
    return `<div id="${FRAGMENT_ID}"></div>`;
  }
  return `<div id="${FRAGMENT_ID}" class="sk-escalation-bar">
    <span class="sk-escalation-bar__icon">!!</span>
    <span class="sk-escalation-bar__text">${count} escalation${count !== 1 ? "s" : ""} require${count === 1 ? "s" : ""} attention</span>
    <a href="/escalations" class="sk-escalation-bar__action">Respond &rarr;</a>
  </div>`;
}
