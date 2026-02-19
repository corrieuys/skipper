import { describe, it, expect } from "bun:test";
import { resolvePlaceholders, shellEscape } from "./placeholder";

describe("shellEscape", () => {
  it("wraps simple value in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("escapes internal single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("handles shell metacharacters", () => {
    const result = shellEscape("$(rm -rf /)");
    expect(result).toBe("'$(rm -rf /)'");
  });

  it("handles semicolons and pipes", () => {
    const result = shellEscape("foo; bar | baz");
    expect(result).toBe("'foo; bar | baz'");
  });
});

describe("resolvePlaceholders", () => {
  it("replaces known placeholders", () => {
    const result = resolvePlaceholders(
      "curl -X POST https://example.com?task={{event.task_id}}",
      { task_id: "abc-123" },
    );
    expect(result).toBe("curl -X POST https://example.com?task='abc-123'");
  });

  it("replaces multiple placeholders", () => {
    const result = resolvePlaceholders(
      "curl -d '{\"task\": {{event.task_id}}, \"title\": {{event.task_title}}}'",
      { task_id: "t1", task_title: "My Task" },
    );
    expect(result).toContain("'t1'");
    expect(result).toContain("'My Task'");
  });

  it("replaces unknown placeholders with empty string", () => {
    const result = resolvePlaceholders(
      "curl https://example.com?err={{event.nonexistent}}",
      { task_id: "t1" },
    );
    expect(result).toBe("curl https://example.com?err=");
  });

  it("shell-escapes values with special characters", () => {
    const result = resolvePlaceholders(
      "curl -d '{{event.body}}'",
      { task_id: "t1", body: "user's input; rm -rf /" },
    );
    expect(result).toContain("'user'\\''s input; rm -rf /'");
  });

  it("returns template unchanged when no placeholders", () => {
    const result = resolvePlaceholders("curl https://example.com", { task_id: "t1" });
    expect(result).toBe("curl https://example.com");
  });

  it("handles empty template", () => {
    const result = resolvePlaceholders("", { task_id: "t1" });
    expect(result).toBe("");
  });

  it("handles undefined values in payload", () => {
    const result = resolvePlaceholders(
      "curl https://example.com?error={{event.error}}",
      { task_id: "t1", error: undefined },
    );
    expect(result).toBe("curl https://example.com?error=");
  });
});
