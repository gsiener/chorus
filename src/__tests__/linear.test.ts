import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncLinearProjects, fetchLinearProjects } from "../linear";
import type { Env } from "../types";

describe("Linear Integration", () => {
  const mockKvStore: Record<string, string> = {};

  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    LINEAR_API_KEY: "lin_api_test_key",
    DOCS_KV: {
      get: vi.fn((key: string) => Promise.resolve(mockKvStore[key] || null)),
      put: vi.fn((key: string, value: string) => {
        mockKvStore[key] = value;
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        delete mockKvStore[key];
        return Promise.resolve();
      }),
    } as unknown as KVNamespace,
    VECTORIZE: {} as unknown as VectorizeIndex,
    AI: {} as unknown as Ai,
  };

  beforeEach(() => {
    // Clear mock KV store
    Object.keys(mockKvStore).forEach((key) => delete mockKvStore[key]);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchLinearProjects throws error when LINEAR_API_KEY is not set", async () => {
    const envWithoutKey = { ...mockEnv, LINEAR_API_KEY: undefined };
    await expect(fetchLinearProjects(envWithoutKey)).rejects.toThrow("LINEAR_API_KEY is not configured");
  });

  it("fetchLinearProjects returns projects from Linear API", async () => {
    const mockProjects = [
      {
        id: "proj-1",
        name: "Test Project",
        description: "A test project",
        state: "started",
        slugId: "test-slug",
        lead: { id: "user-1", name: "Test User", email: "test@example.com" },
      },
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { projects: { nodes: mockProjects } },
      }),
    }));

    const projects = await fetchLinearProjects(mockEnv);

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("Test Project");
    expect(projects[0].state).toBe("started");
  });

  it("syncLinearProjects creates initiatives from projects", async () => {
    const mockProjects = [
      {
        id: "proj-1",
        name: "New Project",
        description: "A new project from Linear",
        state: "planned",
        slugId: "new-proj",
        lead: null,
      },
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { projects: { nodes: mockProjects } },
      }),
    }));

    const result = await syncLinearProjects(mockEnv, "U123");

    expect(result.success).toBe(true);
    expect(result.created).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.message).toContain("1 created");

    // Verify initiative was created
    expect(mockKvStore["initiatives:detail:new-project"]).toBeDefined();
    const initiative = JSON.parse(mockKvStore["initiatives:detail:new-project"]);
    expect(initiative.name).toBe("New Project");
    expect(initiative.status.value).toBe("proposed"); // "planned" maps to "proposed"
  });

  it("syncLinearProjects handles API errors gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }));

    const result = await syncLinearProjects(mockEnv, "U123");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to sync");
  });

  it("syncLinearProjects updates existing initiatives", async () => {
    // Pre-create mapping and initiative
    mockKvStore["linear-map:proj-1"] = "existing-initiative";
    mockKvStore["initiatives:detail:existing-initiative"] = JSON.stringify({
      id: "existing-initiative",
      name: "Existing",
      description: "An existing initiative",
      owner: "U456",
      status: { value: "proposed", updatedAt: "2024-01-01", updatedBy: "test" },
      expectedMetrics: [],
      linearProjectId: "proj-1",
      createdAt: "2024-01-01",
      createdBy: "test",
      updatedAt: "2024-01-01",
    });

    const mockProjects = [
      {
        id: "proj-1",
        name: "Existing",
        description: "An existing initiative",
        state: "started", // Changed from "planned" to "started"
        slugId: "existing",
        lead: null,
      },
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { projects: { nodes: mockProjects } },
      }),
    }));

    const result = await syncLinearProjects(mockEnv, "U123");

    expect(result.success).toBe(true);
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    // Verify status was updated
    const initiative = JSON.parse(mockKvStore["initiatives:detail:existing-initiative"]);
    expect(initiative.status.value).toBe("active"); // "started" maps to "active"
  });
});
