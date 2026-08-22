export function isExperimental(): boolean {
  return process.argv.includes("--experimental");
}

const ALLOWED_TEAM_IDS = new Set<string>([
  "952a24b2-e227-400b-935f-5a74d60998a4", // Software Team
  "b4a6b06b-ff1c-4d10-8ff2-4ced31d018e9", // Real Time
  "c8d4f2a1-7b3e-4c89-9a2f-1e5d3b8c6a47", // Bug Hunters
]);

const ALLOWED_AGENT_IDS = new Set<string>([
  "056fe104-ac53-46bb-b1b6-2a2a08122b8e", // Implementation Analyst
  "a3f9c721-5e8d-4b6a-9c1f-2d8e4b7c5a36", // Bug Analyst
  "123fe123-ac53-46bb-b1b6-2a2a08122b8e", // Librarian
  "b052a0c7-2a2a-4dde-be39-95d88184fded", // Coder
  "7c0d3a92-1f4e-4b8a-9d11-2e6f8b3c5a90", // Tester
  "ff96ca77-3209-47c4-8660-0308d10a1363", // Validator
  "realtime-summarizer",                    // Summarizer
  "skipper",
]);

// User-created teams are always visible. Their ids are registered here so the
// allowlist-filtered dropdowns include them even outside --experimental.
const VISIBLE_LOCAL_TEAM_IDS = new Set<string>();

export function registerVisibleLocalTeam(id: string): void {
  VISIBLE_LOCAL_TEAM_IDS.add(id);
}

export function unregisterVisibleLocalTeam(id: string): void {
  VISIBLE_LOCAL_TEAM_IDS.delete(id);
}

export function isTeamVisible(id: string): boolean {
  return isExperimental() || ALLOWED_TEAM_IDS.has(id) || VISIBLE_LOCAL_TEAM_IDS.has(id);
}

export function isAgentVisible(id: string): boolean {
  return isExperimental() || ALLOWED_AGENT_IDS.has(id);
}
