import { isAbsolute, resolve, relative, sep } from "path";

/**
 * Resolve a model-supplied path against the agent's working directory and refuse
 * anything that escapes it.
 *
 * These tools run inside the daemon process. A vendor CLI puts its own sandbox
 * and permission prompt between the model and the filesystem; we have neither, so
 * the working directory boundary is the only containment a custom agent gets and
 * it is enforced here rather than in each tool.
 *
 * Symlinks are resolved-by-prefix only (lexical `resolve`), matching how the
 * vendor tools treat `..`. A symlink inside the working directory pointing out of
 * it is not caught — noted, not defended: the agent could equally follow it with
 * a relative path it was told about.
 */
export function resolveWithinWorkingDir(workingDir: string, rawPath: string): string {
  const path = (rawPath ?? "").trim();
  if (!path) throw new Error("path is empty");

  const root = resolve(workingDir);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);

  const rel = relative(root, target);
  if (rel === "") return target;
  if (rel.startsWith("..") && (rel.length === 2 || rel[2] === sep)) {
    throw new Error(`path escapes the working directory: ${path}`);
  }
  if (isAbsolute(rel)) {
    throw new Error(`path escapes the working directory: ${path}`);
  }
  return target;
}

/** Path as the model should see it in output: relative to the working directory. */
export function displayPath(workingDir: string, absolutePath: string): string {
  const rel = relative(resolve(workingDir), absolutePath);
  return rel === "" ? "." : rel;
}
