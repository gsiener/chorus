import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addInitiative,
  getInitiative,
  removeInitiative,
  updateInitiativeStatus,
  updateInitiativePrd,
  updateInitiativeName,
  updateInitiativeDescription,
  updateInitiativeOwner,
  addInitiativeMetric,
  listInitiatives,
  formatInitiative,
  formatInitiativeList,
  getInitiativesContext,
  detectInitiativeGaps,
} from "../initiatives";
import type { Env, Initiative } from "../types";

// Mock KV storage
function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    _store: store,
  };
}

function createMockEnv(kv = createMockKV()): Env {
  return {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: kv as unknown as KVNamespace,
    VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn() } as unknown as Ai,
  };
}

describe("Initiative CRUD", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
  });

  describe("addInitiative", () => {
    it("creates a new initiative", async () => {
      const result = await addInitiative(
        mockEnv,
        "Q1 Growth",
        "Increase DAU by 10%",
        "U123",
        "U456"
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("Q1 Growth");
      expect(result.initiative).toBeDefined();
      expect(result.initiative?.name).toBe("Q1 Growth");
      expect(result.initiative?.status.value).toBe("proposed");
      expect(result.initiative?.owner).toBe("U123");
    });

    it("rejects empty name", async () => {
      const result = await addInitiative(mockEnv, "", "desc", "U123", "U456");
      expect(result.success).toBe(false);
      expect(result.message).toContain("cannot be empty");
    });

    it("rejects duplicate names", async () => {
      await addInitiative(mockEnv, "Q1 Growth", "desc", "U123", "U456");
      const result = await addInitiative(mockEnv, "Q1 Growth", "desc2", "U789", "U456");
      expect(result.success).toBe(false);
      expect(result.message).toContain("already exists");
    });
  });

  describe("getInitiative", () => {
    it("retrieves initiative by name", async () => {
      await addInitiative(mockEnv, "Test Initiative", "desc", "U123", "U456");
      const initiative = await getInitiative(mockEnv, "Test Initiative");

      expect(initiative).not.toBeNull();
      expect(initiative?.name).toBe("Test Initiative");
    });

    it("retrieves initiative case-insensitively", async () => {
      await addInitiative(mockEnv, "Test Initiative", "desc", "U123", "U456");
      const initiative = await getInitiative(mockEnv, "test initiative");

      expect(initiative).not.toBeNull();
      expect(initiative?.name).toBe("Test Initiative");
    });

    it("returns null for non-existent initiative", async () => {
      const initiative = await getInitiative(mockEnv, "NonExistent");
      expect(initiative).toBeNull();
    });
  });

  describe("updateInitiativeStatus", () => {
    it("updates status", async () => {
      await addInitiative(mockEnv, "Test", "desc", "U123", "U456");
      const result = await updateInitiativeStatus(mockEnv, "Test", "active", "U789");

      expect(result.success).toBe(true);
      expect(result.message).toContain("active");

      const initiative = await getInitiative(mockEnv, "Test");
      expect(initiative?.status.value).toBe("active");
      expect(initiative?.status.updatedBy).toBe("U789");
    });

    it("fails for non-existent initiative", async () => {
      const result = await updateInitiativeStatus(mockEnv, "NonExistent", "active", "U789");
      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");
    });
  });

  describe("updateInitiativePrd", () => {
    it("adds PRD link", async () => {
      await addInitiative(mockEnv, "Test", "desc", "U123", "U456");
      const result = await updateInitiativePrd(
        mockEnv,
        "Test",
        "https://docs.google.com/doc/123",
        "U789"
      );

      expect(result.success).toBe(true);

      const initiative = await getInitiative(mockEnv, "Test");
      expect(initiative?.prdLink).toBe("https://docs.google.com/doc/123");
    });
  });

  describe("updateInitiativeName", () => {
    it("renames an initiative", async () => {
      await addInitiative(mockEnv, "Old Name", "desc", "U123", "U456");
      const result = await updateInitiativeName(mockEnv, "Old Name", "New Name", "U789");

      expect(result.success).toBe(true);
      expect(result.message).toContain("Renamed");
      expect(result.message).toContain("New Name");

      // New name should find it
      const initiative = await getInitiative(mockEnv, "New Name");
      expect(initiative?.name).toBe("New Name");
      expect(initiative?.description).toBe("desc"); // Other fields preserved
    });

    it("fails for non-existent initiative", async () => {
      const result = await updateInitiativeName(mockEnv, "NonExistent", "New Name", "U789");
      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");
    });
  });

  describe("updateInitiativeDescription", () => {
    it("updates description", async () => {
      await addInitiative(mockEnv, "Test", "old description", "U123", "U456");
      const result = await updateInitiativeDescription(mockEnv, "Test", "new description", "U789");

      expect(result.success).toBe(true);
      expect(result.message).toContain("Updated description");

      const initiative = await getInitiative(mockEnv, "Test");
      expect(initiative?.description).toBe("new description");
    });

    it("fails for non-existent initiative", async () => {
      const result = await updateInitiativeDescription(mockEnv, "NonExistent", "desc", "U789");
      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");
    });
  });

  describe("updateInitiativeOwner", () => {
    it("changes owner", async () => {
      await addInitiative(mockEnv, "Test", "desc", "U123", "U456");
      const result = await updateInitiativeOwner(mockEnv, "Test", "U999", "U789");

      expect(result.success).toBe(true);
      expect(result.message).toContain("Updated owner");
      expect(result.message).toContain("<@U999>");

      const initiative = await getInitiative(mockEnv, "Test");
      expect(initiative?.owner).toBe("U999");
    });

    it("fails for non-existent initiative", async () => {
      const result = await updateInitiativeOwner(mockEnv, "NonExistent", "U999", "U789");
      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");
    });
  });

  describe("addInitiativeMetric", () => {
    it("adds GTM metric", async () => {
      await addInitiative(mockEnv, "Test", "desc", "U123", "U456");
      const result = await addInitiativeMetric(
        mockEnv,
        "Test",
        { type: "gtm", name: "Revenue", target: "$1M ARR" },
        "U789"
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("GTM");

      const initiative = await getInitiative(mockEnv, "Test");
      expect(initiative?.expectedMetrics).toHaveLength(1);
      expect(initiative?.expectedMetrics[0].type).toBe("gtm");
    });

    it("adds Product metric", async () => {
      await addInitiative(mockEnv, "Test", "desc", "U123", "U456");
      const result = await addInitiativeMetric(
        mockEnv,
        "Test",
        { type: "product", name: "DAU", target: "+10%" },
        "U789"
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("Product");
    });
  });

  describe("removeInitiative", () => {
    it("removes initiative", async () => {
      await addInitiative(mockEnv, "Test", "desc", "U123", "U456");
      const result = await removeInitiative(mockEnv, "Test");

      expect(result.success).toBe(true);

      const initiative = await getInitiative(mockEnv, "Test");
      expect(initiative).toBeNull();
    });
  });

  describe("listInitiatives", () => {
    beforeEach(async () => {
      await addInitiative(mockEnv, "Init A", "desc", "U123", "U456");
      await addInitiative(mockEnv, "Init B", "desc", "U789", "U456");
      await updateInitiativeStatus(mockEnv, "Init A", "active", "U456");
    });

    it("lists all initiatives", async () => {
      const result = await listInitiatives(mockEnv);
      expect(result.items).toHaveLength(2);
      expect(result.totalItems).toBe(2);
    });

    it("filters by owner", async () => {
      const result = await listInitiatives(mockEnv, { owner: "U123" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe("Init A");
    });

    it("filters by status", async () => {
      const result = await listInitiatives(mockEnv, { status: "active" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe("Init A");
    });

    it("supports pagination", async () => {
      // Add more initiatives for pagination testing
      for (let i = 0; i < 15; i++) {
        await addInitiative(mockEnv, `Init ${i + 10}`, "desc", "U999", "U456");
      }

      // Test first page
      const page1 = await listInitiatives(mockEnv, undefined, { page: 1, pageSize: 5 });
      expect(page1.items).toHaveLength(5);
      expect(page1.page).toBe(1);
      expect(page1.totalPages).toBe(4); // 17 total / 5 per page = 4 pages
      expect(page1.hasMore).toBe(true);

      // Test second page
      const page2 = await listInitiatives(mockEnv, undefined, { page: 2, pageSize: 5 });
      expect(page2.items).toHaveLength(5);
      expect(page2.page).toBe(2);
      expect(page2.hasMore).toBe(true);

      // Test last page
      const page4 = await listInitiatives(mockEnv, undefined, { page: 4, pageSize: 5 });
      expect(page4.items).toHaveLength(2); // Only 2 remaining
      expect(page4.hasMore).toBe(false);
    });
  });
});

describe("Initiative formatting", () => {
  it("formats initiative for display", () => {
    const initiative: Initiative = {
      id: "test",
      name: "Test Initiative",
      description: "A test description",
      owner: "U123",
      status: { value: "active", updatedAt: "2024-01-01", updatedBy: "U456" },
      expectedMetrics: [
        { type: "gtm", name: "Revenue", target: "$1M" },
        { type: "product", name: "DAU", target: "+10%" },
      ],
      prdLink: "https://docs.google.com/doc/123",
      createdAt: "2024-01-01T00:00:00Z",
      createdBy: "U456",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const formatted = formatInitiative(initiative);

    expect(formatted).toContain("*Test Initiative*");
    expect(formatted).toContain("active");
    expect(formatted).toContain("<@U123>");
    expect(formatted).toContain("Revenue");
    expect(formatted).toContain("DAU");
    expect(formatted).toContain("PRD:");
  });

  it("formats initiative list", () => {
    const initiatives = [
      { id: "1", name: "Init A", owner: "U123", status: "active" as const, hasMetrics: true, hasPrd: true, updatedAt: "2024-01-01" },
      { id: "2", name: "Init B", owner: "U456", status: "proposed" as const, hasMetrics: false, hasPrd: false, updatedAt: "2024-01-01" },
    ];

    const formatted = formatInitiativeList(initiatives);

    expect(formatted).toContain("*Initiatives*");
    expect(formatted).toContain("Init A");
    expect(formatted).toContain("Init B");
    expect(formatted).toContain("no PRD");
    expect(formatted).toContain("no metrics");
  });

  it("shows empty message when no initiatives", () => {
    const formatted = formatInitiativeList([]);
    expect(formatted).toContain("No initiatives found");
  });
});

describe("getInitiativesContext", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
  });

  it("returns null when no initiatives", async () => {
    const context = await getInitiativesContext(mockEnv);
    expect(context).toBeNull();
  });

  it("returns context for active initiatives", async () => {
    await addInitiative(mockEnv, "Test", "A description", "U123", "U456");
    await updateInitiativeStatus(mockEnv, "Test", "active", "U456");

    const context = await getInitiativesContext(mockEnv);

    expect(context).not.toBeNull();
    expect(context).toContain("Test");
    expect(context).toContain("active");
    expect(context).toContain("missing PRD");
    expect(context).toContain("no metrics defined");
  });

  it("excludes completed initiatives", async () => {
    await addInitiative(mockEnv, "Done", "desc", "U123", "U456");
    await updateInitiativeStatus(mockEnv, "Done", "completed", "U456");

    const context = await getInitiativesContext(mockEnv);
    expect(context).toBeNull();
  });
});

describe("detectInitiativeGaps", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
  });

  it("returns null when no initiatives", async () => {
    const nudge = await detectInitiativeGaps("tell me about something", mockEnv);
    expect(nudge).toBeNull();
  });

  it("returns nudge for initiative with missing PRD", async () => {
    await addInitiative(mockEnv, "Mobile App Launch", "Launch mobile app", "U123", "U456");

    const nudge = await detectInitiativeGaps("What's the status of Mobile App Launch?", mockEnv);

    expect(nudge).not.toBeNull();
    expect(nudge).toContain("Mobile App Launch");
    expect(nudge).toContain("PRD");
    expect(nudge).toContain("gently");
  });

  it("returns null when initiative has all info", async () => {
    await addInitiative(mockEnv, "Complete Initiative", "All info provided", "U123", "U456");
    await updateInitiativePrd(mockEnv, "Complete Initiative", "https://docs.google.com/123", "U456");
    await addInitiativeMetric(mockEnv, "Complete Initiative", { type: "product", name: "DAU", target: "+10%" }, "U456");

    const nudge = await detectInitiativeGaps("Tell me about Complete Initiative", mockEnv);
    expect(nudge).toBeNull();
  });

  it("detects initiative mentions case-insensitively", async () => {
    await addInitiative(mockEnv, "Q1 Revenue Goal", "Increase revenue", "U123", "U456");

    const nudge = await detectInitiativeGaps("How is the q1 revenue goal going?", mockEnv);

    expect(nudge).not.toBeNull();
    expect(nudge).toContain("Q1 Revenue Goal");
  });

  it("returns only one nudge for multiple initiatives with gaps", async () => {
    await addInitiative(mockEnv, "Project A", "First project", "U123", "U456");
    await addInitiative(mockEnv, "Project B", "Second project", "U123", "U456");

    const nudge = await detectInitiativeGaps("Tell me about Project A and Project B", mockEnv);

    // Should only have one nudge (first match)
    expect(nudge).not.toBeNull();
    const prdCount = (nudge!.match(/PRD/g) || []).length;
    expect(prdCount).toBe(1);
  });
});
