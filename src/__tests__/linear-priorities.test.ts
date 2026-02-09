import { describe, it, expect } from "vitest";
import { extractPriorityMetadata, LinearInitiative } from "../linear-priorities";

function makeInitiative(overrides: Partial<LinearInitiative> = {}): LinearInitiative {
  return {
    id: "test-id",
    name: "Test Initiative",
    description: null,
    status: "Active",
    targetDate: null,
    url: "https://linear.app/test",
    owner: null,
    content: null,
    projects: { nodes: [] },
    ...overrides,
  };
}

describe("extractPriorityMetadata", () => {
  it("extracts Slack channel from description", () => {
    const init = makeInitiative({
      description: "Some description\n- Slack: #proj-search",
    });
    const { slackChannel } = extractPriorityMetadata(init);
    expect(slackChannel).toBe("#proj-search");
  });

  it("extracts Slack channel from content field", () => {
    const init = makeInitiative({
      content: "- Slack: #team-platform",
    });
    const { slackChannel } = extractPriorityMetadata(init);
    expect(slackChannel).toBe("#team-platform");
  });

  it("returns null when no Slack field present", () => {
    const init = makeInitiative({
      description: "Just a plain description with no metadata",
    });
    const { slackChannel } = extractPriorityMetadata(init);
    expect(slackChannel).toBeNull();
  });

  it("handles full metadata block", () => {
    const init = makeInitiative({
      description: `---
**R&D Priority Info**
- Tech Risk: 🌶🌶🌶
- Theme: Q1 - Enterprise Growth
- Slack: #proj-enterprise`,
    });
    const { techRisk, theme, slackChannel } = extractPriorityMetadata(init);
    expect(techRisk).toBe("🌶🌶🌶");
    expect(theme).toBe("Q1 - Enterprise Growth");
    expect(slackChannel).toBe("#proj-enterprise");
  });

  it("handles extra whitespace around Slack channel", () => {
    const init = makeInitiative({
      description: "- Slack:   #proj-analytics  ",
    });
    const { slackChannel } = extractPriorityMetadata(init);
    expect(slackChannel).toBe("#proj-analytics");
  });

  it("handles channel names with numbers", () => {
    const init = makeInitiative({
      description: "- Slack: #team-platform-2026",
    });
    const { slackChannel } = extractPriorityMetadata(init);
    expect(slackChannel).toBe("#team-platform-2026");
  });
});
