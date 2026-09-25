import { describe, it, expect } from "bun:test";
import { allowedHostsPanel } from "./config.page";
import type { AllowedHostsView } from "../../config/allowed-hosts";

// The Allowed Hosts section: the environment's part shown read-only, the saved
// list editable, and a Save that swaps the section in place.

const unsetEnv: AllowedHostsView = {
  hosts: [],
  bindAddress: "127.0.0.1",
  bindHostEnv: null,
  bindHostname: null,
  envAllowedHosts: null,
};

/** The visible value next to a row label, tags stripped. */
function rowValue(html: string, label: string): string {
  const match = new RegExp(`>${label}</span>\\s*<span[^>]*>([\\s\\S]*?)</span>\\s*</div>`).exec(html);
  return (match?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

describe("allowedHostsPanel", () => {
  it("shows the always-allowed rule and reports unset environment variables as not set", () => {
    const html = allowedHostsPanel(unsetEnv);
    expect(rowValue(html, "Always allowed")).toBe("localhost and any IP address");
    expect(rowValue(html, "SKIPPER_ALLOWED_HOSTS")).toBe("not set");
    expect(rowValue(html, "SKIPPER_HOST")).toBe(
      "not set, so Skipper binds 127.0.0.1 (the default). Adds no hostname: IP addresses and localhost are always allowed.",
    );
    expect(html).toContain("skipper start --host");
  });

  it("shows set environment values verbatim, escaped, and the name a bind hostname adds", () => {
    const html = allowedHostsPanel({
      hosts: [],
      bindAddress: "my-mac.local",
      bindHostEnv: "my-mac.local",
      bindHostname: "my-mac.local",
      envAllowedHosts: "a.local, b.local:8443 <b>",
    });
    expect(rowValue(html, "SKIPPER_ALLOWED_HOSTS")).toBe("a.local, b.local:8443 &lt;b&gt;");
    expect(rowValue(html, "SKIPPER_HOST")).toBe("my-mac.local (the bind address). Adds my-mac.local to the allowed hosts.");
    expect(html).not.toContain("<b>");
  });

  it("puts the saved list in the textarea, one per line, and posts it for an in-place swap", () => {
    const html = allowedHostsPanel({ ...unsetEnv, hosts: ["a.local", "b.local"] });
    expect(html).toStartWith('<div id="sk-allowed-hosts-panel" class="sk-panel"');
    expect(html).toContain('name="hosts"');
    expect(html).toContain(">a.local\nb.local</textarea>");
    expect(html).toContain('hx-post="/api/config/allowed-hosts" hx-target="#sk-allowed-hosts-panel" hx-swap="outerHTML"');
    expect(html).not.toContain("location.reload");
    expect(html).not.toContain("Saved.");
    expect(html).not.toContain("Not saved");
  });

  it("after a refused save keeps the typed text and lists the errors inline", () => {
    const html = allowedHostsPanel(
      { ...unsetEnv, hosts: ["kept.local"] },
      { input: "kept.local\n10.0.0.5", errors: ["10.0.0.5: IP addresses are always allowed, no need to list them"] },
    );
    expect(html).toContain(">kept.local\n10.0.0.5</textarea>");
    expect(html).toContain("Not saved");
    expect(html).toContain("<li>10.0.0.5: IP addresses are always allowed, no need to list them</li>");
  });

  it("confirms a save", () => {
    expect(allowedHostsPanel(unsetEnv, { saved: true })).toContain("Saved. Applies now, no restart needed.");
  });
});
