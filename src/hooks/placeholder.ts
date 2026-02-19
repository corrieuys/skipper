import type { HookEventPayload } from "./types";

export function resolvePlaceholders(template: string, payload: HookEventPayload): string {
  return template.replace(/\{\{event\.(\w+)\}\}/g, (_match, field: string) => {
    const value = (payload as unknown as Record<string, string | undefined>)[field];
    if (value === undefined) return "";
    return shellEscape(value);
  });
}

export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
