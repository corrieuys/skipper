import { describe, it, expect } from "bun:test";
import { WhisperManager } from "./manager";

describe("WhisperManager", () => {
  it("initializes with default options", () => {
    const mgr = new WhisperManager();
    expect(mgr.isRunning()).toBe(false);
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8080/inference");
  });

  it("accepts custom host and port", () => {
    const mgr = new WhisperManager({ host: "0.0.0.0", port: 9090 });
    expect(mgr.getEndpoint()).toBe("http://0.0.0.0:9090/inference");
  });

  it("stop is a no-op when not running", () => {
    const mgr = new WhisperManager();
    // Should not throw
    mgr.stop();
    expect(mgr.isRunning()).toBe(false);
  });

  it("start throws when binary not found", async () => {
    const mgr = new WhisperManager({
      binaryPath: "/nonexistent/whisper-server",
      modelPath: "/nonexistent/model.bin",
    });
    await expect(mgr.start()).rejects.toThrow("binary not found");
  });

  it("start throws when model not found", async () => {
    // Use a real binary path that exists (like /bin/echo) but fake model
    const mgr = new WhisperManager({
      binaryPath: "/bin/echo",
      modelPath: "/nonexistent/model.bin",
    });
    await expect(mgr.start()).rejects.toThrow("model not found");
  });

  it("throws if started twice", async () => {
    // We can't easily test actual startup without whisper.cpp installed,
    // but we can verify the guard logic by mocking state
    const mgr = new WhisperManager();
    // Manually set proc to simulate running state
    (mgr as any).proc = { kill: () => {} };
    await expect(mgr.start()).rejects.toThrow("already running");
    // Clean up
    (mgr as any).proc = null;
  });
});
