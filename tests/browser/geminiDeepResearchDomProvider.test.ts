import { describe, expect, it, vi } from "vitest";
import { geminiDeepResearchDomProvider } from "../../src/browser/providers/geminiDeepResearchDomProvider.js";

describe("geminiDeepResearchDomProvider", () => {
  it("rejects disabled Deep Research tools instead of falling through to Fast search", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce("clicked")
      .mockResolvedValueOnce({
        status: "disabled",
        available: ["Create image", "Deep research"],
        requiresLogin: true,
      });

    await expect(
      geminiDeepResearchDomProvider.selectMode?.({
        prompt: "hello",
        evaluate,
        delay: async () => undefined,
      }),
    ).rejects.toThrow(/Deep Research is disabled.*sign-in/i);
  });
});
