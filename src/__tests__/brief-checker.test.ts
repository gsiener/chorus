import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  hasBrief,
  checkInitiativeBriefs,
  formatBriefCheckResults,
  type InitiativeWithLinks,
  type BriefCheckResult,
} from "../brief-checker";
import { createMockEnv, cleanupMocks } from "./helpers";

// Mock the dependencies
vi.mock("../slack", () => ({
  postDirectMessage: vi.fn(),
}));

vi.mock("../user-mapping", () => ({
  findUserByEmail: vi.fn(),
}));

// We need to import after mocking
import { postDirectMessage } from "../slack";
import { findUserByEmail } from "../user-mapping";

describe("brief-checker", () => {
  describe("hasBrief", () => {
    it('returns true when link has "brief" in label', () => {
      const initiative: InitiativeWithLinks = {
        id: "init-1",
        name: "Test Initiative",
        url: "https://linear.app/test/init-1",
        owner: { name: "Test Owner", email: "test@example.com" },
        links: {
          nodes: [
            { id: "link-1", label: "Project Brief", url: "https://docs.google.com/brief" },
          ],
        },
      };

      expect(hasBrief(initiative)).toBe(true);
    });

    it('returns true case-insensitively for "brief" in label', () => {
      const initiative: InitiativeWithLinks = {
        id: "init-1",
        name: "Test Initiative",
        url: "https://linear.app/test/init-1",
        owner: { name: "Test Owner", email: "test@example.com" },
        links: {
          nodes: [
            { id: "link-1", label: "BRIEF DOCUMENT", url: "https://docs.google.com/brief" },
          ],
        },
      };

      expect(hasBrief(initiative)).toBe(true);
    });

    it('returns true when "brief" is in label with mixed case', () => {
      const initiative: InitiativeWithLinks = {
        id: "init-1",
        name: "Test Initiative",
        url: "https://linear.app/test/init-1",
        owner: { name: "Test Owner", email: "test@example.com" },
        links: {
          nodes: [
            { id: "link-1", label: "Initiative BrIeF", url: "https://docs.google.com/brief" },
          ],
        },
      };

      expect(hasBrief(initiative)).toBe(true);
    });

    it('returns false when no links contain "brief"', () => {
      const initiative: InitiativeWithLinks = {
        id: "init-1",
        name: "Test Initiative",
        url: "https://linear.app/test/init-1",
        owner: { name: "Test Owner", email: "test@example.com" },
        links: {
          nodes: [
            { id: "link-1", label: "Design Doc", url: "https://docs.google.com/design" },
            { id: "link-2", label: "Roadmap", url: "https://docs.google.com/roadmap" },
          ],
        },
      };

      expect(hasBrief(initiative)).toBe(false);
    });

    it("returns false when links array is empty", () => {
      const initiative: InitiativeWithLinks = {
        id: "init-1",
        name: "Test Initiative",
        url: "https://linear.app/test/init-1",
        owner: { name: "Test Owner", email: "test@example.com" },
        links: {
          nodes: [],
        },
      };

      expect(hasBrief(initiative)).toBe(false);
    });

    it("returns false when link label is null", () => {
      const initiative: InitiativeWithLinks = {
        id: "init-1",
        name: "Test Initiative",
        url: "https://linear.app/test/init-1",
        owner: { name: "Test Owner", email: "test@example.com" },
        links: {
          nodes: [
            { id: "link-1", label: null, url: "https://docs.google.com/something" },
          ],
        },
      };

      expect(hasBrief(initiative)).toBe(false);
    });
  });

  describe("checkInitiativeBriefs", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      cleanupMocks();
    });

    it("returns empty result when no initiatives", async () => {
      const env = createMockEnv({ LINEAR_API_KEY: "test-api-key" });

      // Mock Linear API to return empty initiatives
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                initiativeRelations: {
                  nodes: [],
                },
              },
            }),
        })
      );

      const result = await checkInitiativeBriefs(env);

      expect(result.initiativesChecked).toBe(0);
      expect(result.missingBriefs).toHaveLength(0);
      expect(result.unmappedUsers).toHaveLength(0);
    });

    it("skips initiatives that have briefs", async () => {
      const env = createMockEnv({ LINEAR_API_KEY: "test-api-key" });

      // Mock Linear API to return initiative with brief
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                initiativeRelations: {
                  nodes: [
                    {
                      sortOrder: 1,
                      initiative: { id: "test-rd-priorities-id" },
                      relatedInitiative: {
                        id: "init-1",
                        name: "Initiative with Brief",
                        url: "https://linear.app/test/init-1",
                        owner: { name: "Test User", email: "test@example.com" },
                        links: {
                          nodes: [
                            { id: "link-1", label: "Brief", url: "https://docs.google.com/brief" },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            }),
        })
      );

      const result = await checkInitiativeBriefs(env);

      expect(result.initiativesChecked).toBe(1);
      expect(result.missingBriefs).toHaveLength(0);
      expect(postDirectMessage).not.toHaveBeenCalled();
    });

    it("sends DM when brief is missing and user is mapped", async () => {
      const env = createMockEnv({ LINEAR_API_KEY: "test-api-key" });

      // Mock Linear API to return initiative without brief
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                initiativeRelations: {
                  nodes: [
                    {
                      sortOrder: 1,
                      initiative: { id: "test-rd-priorities-id" },
                      relatedInitiative: {
                        id: "init-1",
                        name: "Initiative without Brief",
                        url: "https://linear.app/test/init-1",
                        owner: { name: "Test User", email: "test@example.com" },
                        links: {
                          nodes: [],
                        },
                      },
                    },
                  ],
                },
              },
            }),
        })
      );

      // Mock user lookup
      vi.mocked(findUserByEmail).mockReturnValue({
        email: "test@example.com",
        name: "Test User",
        linearId: "linear-123",
        slackId: "U123",
      });

      // Mock DM sending
      vi.mocked(postDirectMessage).mockResolvedValue({ ts: "1234.5678" });

      const result = await checkInitiativeBriefs(env);

      expect(result.initiativesChecked).toBe(1);
      expect(result.missingBriefs).toHaveLength(1);
      expect(result.missingBriefs[0]).toEqual({
        initiative: {
          name: "Initiative without Brief",
          url: "https://linear.app/test/init-1",
        },
        owner: { name: "Test User", email: "test@example.com" },
        dmSent: true,
      });
      expect(postDirectMessage).toHaveBeenCalledWith(
        "U123",
        expect.stringContaining("Initiative without Brief"),
        env
      );
    });

    it("adds to unmappedUsers when user not found", async () => {
      const env = createMockEnv({ LINEAR_API_KEY: "test-api-key" });

      // Mock Linear API to return initiative without brief
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                initiativeRelations: {
                  nodes: [
                    {
                      sortOrder: 1,
                      initiative: { id: "test-rd-priorities-id" },
                      relatedInitiative: {
                        id: "init-1",
                        name: "Initiative without Brief",
                        url: "https://linear.app/test/init-1",
                        owner: { name: "Unknown User", email: "unknown@example.com" },
                        links: {
                          nodes: [],
                        },
                      },
                    },
                  ],
                },
              },
            }),
        })
      );

      // Mock user lookup - user not found
      vi.mocked(findUserByEmail).mockReturnValue(undefined);

      const result = await checkInitiativeBriefs(env);

      expect(result.initiativesChecked).toBe(1);
      expect(result.missingBriefs).toHaveLength(1);
      expect(result.missingBriefs[0].dmSent).toBe(false);
      expect(result.unmappedUsers).toContain("unknown@example.com");
      expect(postDirectMessage).not.toHaveBeenCalled();
    });

    it("respects notification cooldown", async () => {
      const env = createMockEnv({ LINEAR_API_KEY: "test-api-key" });

      // Set up cooldown - user was notified recently
      env._kv._store.set("brief-check:notified:init-1", Date.now().toString());

      // Mock Linear API to return initiative without brief
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                initiativeRelations: {
                  nodes: [
                    {
                      sortOrder: 1,
                      initiative: { id: "test-rd-priorities-id" },
                      relatedInitiative: {
                        id: "init-1",
                        name: "Initiative without Brief",
                        url: "https://linear.app/test/init-1",
                        owner: { name: "Test User", email: "test@example.com" },
                        links: {
                          nodes: [],
                        },
                      },
                    },
                  ],
                },
              },
            }),
        })
      );

      // Mock user lookup
      vi.mocked(findUserByEmail).mockReturnValue({
        email: "test@example.com",
        name: "Test User",
        linearId: "linear-123",
        slackId: "U123",
      });

      const result = await checkInitiativeBriefs(env);

      expect(result.initiativesChecked).toBe(1);
      expect(result.missingBriefs).toHaveLength(1);
      expect(result.missingBriefs[0].dmSent).toBe(false);
      expect(postDirectMessage).not.toHaveBeenCalled();
    });

    it("handles initiative without owner", async () => {
      const env = createMockEnv({ LINEAR_API_KEY: "test-api-key" });

      // Mock Linear API to return initiative without owner
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                initiativeRelations: {
                  nodes: [
                    {
                      sortOrder: 1,
                      initiative: { id: "test-rd-priorities-id" },
                      relatedInitiative: {
                        id: "init-1",
                        name: "Ownerless Initiative",
                        url: "https://linear.app/test/init-1",
                        owner: null,
                        links: {
                          nodes: [],
                        },
                      },
                    },
                  ],
                },
              },
            }),
        })
      );

      const result = await checkInitiativeBriefs(env);

      expect(result.initiativesChecked).toBe(1);
      expect(result.missingBriefs).toHaveLength(1);
      expect(result.missingBriefs[0].dmSent).toBe(false);
      expect(postDirectMessage).not.toHaveBeenCalled();
    });
  });

  describe("formatBriefCheckResults", () => {
    it("formats results with no missing briefs", () => {
      const result: BriefCheckResult = {
        initiativesChecked: 5,
        missingBriefs: [],
        unmappedUsers: [],
      };

      const formatted = formatBriefCheckResults(result);

      expect(formatted).toContain("5 initiatives checked");
      expect(formatted).toContain("All initiatives have briefs");
    });

    it("formats results with missing briefs", () => {
      const result: BriefCheckResult = {
        initiativesChecked: 3,
        missingBriefs: [
          {
            initiative: { name: "Initiative A", url: "https://linear.app/a" },
            owner: { name: "Alice", email: "alice@example.com" },
            dmSent: true,
          },
          {
            initiative: { name: "Initiative B", url: "https://linear.app/b" },
            owner: { name: "Bob", email: "bob@example.com" },
            dmSent: false,
          },
        ],
        unmappedUsers: [],
      };

      const formatted = formatBriefCheckResults(result);

      expect(formatted).toContain("3 initiatives checked");
      expect(formatted).toContain("2 missing briefs");
      expect(formatted).toContain("Initiative A");
      expect(formatted).toContain("Alice");
      expect(formatted).toContain("DM sent");
      expect(formatted).toContain("Initiative B");
      expect(formatted).toContain("Bob");
    });

    it("formats results with unmapped users", () => {
      const result: BriefCheckResult = {
        initiativesChecked: 2,
        missingBriefs: [
          {
            initiative: { name: "Initiative A", url: "https://linear.app/a" },
            owner: { name: "Unknown", email: "unknown@example.com" },
            dmSent: false,
          },
        ],
        unmappedUsers: ["unknown@example.com"],
      };

      const formatted = formatBriefCheckResults(result);

      expect(formatted).toContain("Unmapped users");
      expect(formatted).toContain("unknown@example.com");
    });

    it("includes error messages when present", () => {
      const result: BriefCheckResult = {
        initiativesChecked: 1,
        missingBriefs: [
          {
            initiative: { name: "Initiative A", url: "https://linear.app/a" },
            owner: { name: "Alice", email: "alice@example.com" },
            dmSent: false,
            error: "channel_not_found",
          },
        ],
        unmappedUsers: [],
      };

      const formatted = formatBriefCheckResults(result);

      expect(formatted).toContain("channel_not_found");
    });
  });
});
