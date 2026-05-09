import { describe, expect, it } from "vitest";
import { buildAgentModeExpressionForTest } from "../../src/browser/actions/agentMode.js";

describe("browser agent-mode", () => {
  it("uses CDP Input clicks and correct selectors", () => {
    const expression = buildAgentModeExpressionForTest();
    expect(expression).toContain("dispatchClickSequence");
    expect(expression).toContain("composer-plus-btn");
    expect(expression).toContain("menuitemradio");
    expect(expression).toContain("role=switch");
  });
});
