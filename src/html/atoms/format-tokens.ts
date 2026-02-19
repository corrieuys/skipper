export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(n);
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

/**
 * Headline token count: input + output + cache_creation. Excludes cache_read
 * because cached-prefix replay is billed at ~10% and dominates by 10–50× on
 * long Skipper sessions, which makes any sum that includes it useless as a
 * "how much work did this agent do" signal. The full breakdown is still
 * surfaced via the tooltip on the badge.
 */
export function totalTokens(t: TokenBreakdown): number {
  return t.input + t.output + t.cache_creation;
}
