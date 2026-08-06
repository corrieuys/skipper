/** What a local tool needs to know about the run it belongs to. */
export interface ToolContext {
  /** Absolute directory every path in every tool resolves against, and cannot escape. */
  workingDir: string;
}
