import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addInitiative,
  getInitiative,
  removeInitiative,
  updateInitiativeStatus,
  updateInitiativePrd,
  addInitiativeMetric,
  listInitiatives,
  formatInitiative,
  formatInitiativeList,
  getInitiativesContext,
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
      const initiatives = await listInitiatives(mockEnv);
      expect(initiatives).toHaveLength(2);
    });

    it("filters by owner", async () => {
      const initiatives = await listInitiatives(mockEnv, { owner: "U123" });
      expect(initiatives).toHaveLength(1);
      expect(initiatives[0].name).toBe("Init A");
    });

    it("filters by status", async () => {
      const initiatives = await listInitiatives(mockEnv, { status: "active" });
      expect(initiatives).toHaveLength(1);
      expect(initiatives[0].name).toBe("Init A");
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
