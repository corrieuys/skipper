// GitHub Releases lookup for the auto-update checker. Mirrors the stable-channel
// resolution in bin/cli.ts (resolveLatestTag), kept here so the daemon can fetch
// without importing the CLI entry (which runs main() on import).

export const SKIPPER_REPO = "corrieuys/skipper";

/**
 * Fetch the latest STABLE release tag (GitHub's /releases/latest excludes
 * prereleases), returned with any leading "v" stripped. Returns null on any
 * network/API failure or missing tag — the caller treats null as "no info".
 */
export async function fetchLatestStableTag(): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${SKIPPER_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "skipper-cli" },
    });
    if (!res.ok) return null;
    const tag = ((await res.json()) as { tag_name?: string }).tag_name;
    if (!tag) return null;
    return tag.replace(/^v/, "");
  } catch {
    return null;
  }
}
