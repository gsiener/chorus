import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addDocument,
  updateDocument,
  removeDocument,
  listDocuments,
  getKnowledgeBase,
  backfillDocuments,
  backfillIfNeeded,
  getRandomDocument,
} from "../docs";
import type { Env } from "../types";

// Mock embeddings module
vi.mock("../embeddings", () => ({
  indexDocument: vi.fn().mockResolvedValue({ success: true, chunksIndexed: 1, message: "Indexed" }),
  removeDocumentFromIndex: vi.fn().mockResolvedValue({ success: true, message: "Removed" }),
}));

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
    VECTORIZE: { query: vi.fn(), insert: vi.fn(), deleteByIds: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }) } as unknown as Ai,
  };
}

describe("addDocument", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
    vi.clearAllMocks();
  });

  it("adds a document successfully", async () => {
    const result = await addDocument(mockEnv, "Test Doc", "Test content here", "U123");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Test Doc");
    expect(result.message).toContain("17 chars"); // "Test content here" is 17 chars

    // Verify stored in KV
    expect(mockKV._store.get("docs:content:test-doc")).toBe("Test content here");
  });

  it("rejects empty title", async () => {
    const result = await addDocument(mockEnv, "", "content", "U123");

    expect(result.success).toBe(false);
    expect(result.message).toContain("cannot be empty");
  });

  it("rejects whitespace-only title", async () => {
    const result = await addDocument(mockEnv, "   ", "content", "U123");

    expect(result.success).toBe(false);
    expect(result.message).toContain("cannot be empty");
  });

  it("rejects title exceeding max length", async () => {
    const longTitle = "a".repeat(101);
    const result = await addDocument(mockEnv, longTitle, "content", "U123");

    expect(result.success).toBe(false);
    expect(result.message).toContain("too long");
  });

  it("rejects document exceeding max size", async () => {
    const largeContent = "x".repeat(50001);
    const result = await addDocument(mockEnv, "Test", largeContent, "U123");

    expect(result.success).toBe(false);
    expect(result.message).toContain("too large");
  });

  it("rejects duplicate title (case-insensitive)", async () => {
    await addDocument(mockEnv, "My Document", "content 1", "U123");
    const result = await addDocument(mockEnv, "my document", "content 2", "U456");

    expect(result.success).toBe(false);
    expect(result.message).toContain("already exists");
  });

  it("rejects when knowledge base is full", async () => {
    // MAX_TOTAL_KB_SIZE is 200000, MAX_DOC_SIZE is 50000 per doc
    // Add 4 docs at 49000 chars each = 196000 chars total
    for (let i = 0; i < 4; i++) {
      const result = await addDocument(mockEnv, `Doc ${i}`, "x".repeat(49000), "U123");
      expect(result.success).toBe(true);
    }

    // Try to add another that would exceed the 200000 limit
    const result = await addDocument(mockEnv, "Another", "x".repeat(10000), "U123");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Knowledge base full");
  });

  it("sanitizes title for KV key", async () => {
    await addDocument(mockEnv, "Test Doc!@#$%", "content", "U123");

    // Special chars removed, spaces become hyphens
    expect(mockKV._store.has("docs:content:test-doc")).toBe(true);
  });

  it("handles title with only special characters", async () => {
    // Title with only special chars throws error because sanitized key is empty
    await expect(addDocument(mockEnv, "!@#$%", "content", "U123")).rejects.toThrow(
      "Invalid title: results in empty key after sanitization"
    );
  });

  it("indexes document for semantic search", async () => {
    const { indexDocument } = await import("../embeddings");

    await addDocument(mockEnv, "Searchable", "content for search", "U123");

    expect(indexDocument).toHaveBeenCalledWith("Searchable", "content for search", mockEnv);
  });
});

describe("updateDocument", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
    vi.clearAllMocks();
  });

  it("updates existing document content", async () => {
    await addDocument(mockEnv, "Test Doc", "Original content", "U123");
    const result = await updateDocument(mockEnv, "Test Doc", "Updated content", "U456");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Updated");
    expect(result.message).toContain("Test Doc");
    expect(mockKV._store.get("docs:content:test-doc")).toBe("Updated content");
  });

  it("updates document case-insensitively", async () => {
    await addDocument(mockEnv, "My Document", "original", "U123");
    const result = await updateDocument(mockEnv, "my document", "updated", "U456");

    expect(result.success).toBe(true);
    expect(mockKV._store.get("docs:content:my-document")).toBe("updated");
  });

  it("fails for non-existent document", async () => {
    const result = await updateDocument(mockEnv, "Does Not Exist", "content", "U123");

    expect(result.success).toBe(false);
    expect(result.message).toContain("No document titled");
  });

  it("rejects content exceeding max size", async () => {
    await addDocument(mockEnv, "Small Doc", "small", "U123");
    const largeContent = "x".repeat(50001);
    const result = await updateDocument(mockEnv, "Small Doc", largeContent, "U456");

    expect(result.success).toBe(false);
    expect(result.message).toContain("too large");
  });

  it("rejects update that would exceed total KB limit", async () => {
    // Add 4 docs at 49000 chars each = 196000 chars total
    for (let i = 0; i < 4; i++) {
      await addDocument(mockEnv, `Doc ${i}`, "x".repeat(49000), "U123");
    }
    // Add a small doc to bring total to exactly 200000 (at limit)
    await addDocument(mockEnv, "Small Doc", "x".repeat(4000), "U123");

    // Try to update the small doc with 4001 chars
    // New total would be: 200000 - 4000 + 4001 = 200001 > 200000 limit
    // But 4001 < 50000 so per-doc limit passes
    const result = await updateDocument(mockEnv, "Small Doc", "x".repeat(4001), "U456");

    expect(result.success).toBe(false);
    expect(result.message).toContain("would exceed limit");
  });

  it("shows size change in message", async () => {
    await addDocument(mockEnv, "Test Doc", "short", "U123");
    const result = await updateDocument(mockEnv, "Test Doc", "much longer content here", "U456");

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/[+-]\d+/); // Shows size change
  });

  it("re-indexes document for semantic search", async () => {
    const { indexDocument } = await import("../embeddings");

    await addDocument(mockEnv, "Searchable", "original", "U123");
    vi.clearAllMocks();
    await updateDocument(mockEnv, "Searchable", "updated for search", "U456");

    expect(indexDocument).toHaveBeenCalledWith("Searchable", "updated for search", mockEnv);
  });
});

describe("removeDocument", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
    vi.clearAllMocks();
  });

  it("removes existing document", async () => {
    await addDocument(mockEnv, "To Remove", "content", "U123");
    const result = await removeDocument(mockEnv, "To Remove");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Removed");
    expect(mockKV._store.has("docs:content:to-remove")).toBe(false);
  });

  it("removes document case-insensitively", async () => {
    await addDocument(mockEnv, "My Document", "content", "U123");
    const result = await removeDocument(mockEnv, "MY DOCUMENT");

    expect(result.success).toBe(true);
  });

  it("fails for non-existent document", async () => {
    const result = await removeDocument(mockEnv, "Does Not Exist");

    expect(result.success).toBe(false);
    expect(result.message).toContain("No document titled");
  });

  it("removes from vector index", async () => {
    const { removeDocumentFromIndex } = await import("../embeddings");

    await addDocument(mockEnv, "Indexed Doc", "content", "U123");
    await removeDocument(mockEnv, "Indexed Doc");

    expect(removeDocumentFromIndex).toHaveBeenCalledWith("Indexed Doc", mockEnv);
  });
});

describe("listDocuments", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
    vi.clearAllMocks();
  });

  it("returns empty message when no documents", async () => {
    const result = await listDocuments(mockEnv);

    expect(result).toContain("empty");
    expect(result).toContain("@Chorus add doc");
  });

  it("lists all documents with metadata", async () => {
    await addDocument(mockEnv, "Doc One", "content one", "U123");
    await addDocument(mockEnv, "Doc Two", "longer content here", "U456");

    const result = await listDocuments(mockEnv);

    expect(result).toContain("Doc One");
    expect(result).toContain("Doc Two");
    expect(result).toContain("2 docs");
  });

  it("shows character count for each document", async () => {
    await addDocument(mockEnv, "Test", "12345", "U123");

    const result = await listDocuments(mockEnv);

    expect(result).toContain("5 chars");
  });
});

describe("getKnowledgeBase", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
    vi.clearAllMocks();
  });

  it("returns null when no documents", async () => {
    const result = await getKnowledgeBase(mockEnv);
    expect(result).toBeNull();
  });

  it("returns formatted knowledge base", async () => {
    await addDocument(mockEnv, "Strategy", "Our strategy is...", "U123");
    await addDocument(mockEnv, "Roadmap", "Q1 priorities...", "U456");

    const result = await getKnowledgeBase(mockEnv);

    expect(result).toContain("## Strategy");
    expect(result).toContain("Our strategy is...");
    expect(result).toContain("## Roadmap");
    expect(result).toContain("Q1 priorities...");
    expect(result).toContain("---"); // Separator
  });

  it("handles missing content gracefully", async () => {
    // Manually corrupt the index by adding entry without content
    mockKV._store.set("docs:index", JSON.stringify({
      documents: [{ title: "Ghost Doc", addedBy: "U123", addedAt: "2024-01-01", charCount: 100 }],
    }));

    const result = await getKnowledgeBase(mockEnv);

    // Should return null since content is missing
    expect(result).toBeNull();
  });
});

describe("backfillDocuments", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
    vi.clearAllMocks();
  });

  it("returns success when no documents", async () => {
    const result = await backfillDocuments(mockEnv);

    expect(result.success).toBe(true);
    expect(result.indexed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("indexes all documents", async () => {
    await addDocument(mockEnv, "Doc 1", "content 1", "U123");
    await addDocument(mockEnv, "Doc 2", "content 2", "U123");

    vi.clearAllMocks(); // Clear the calls from addDocument

    const result = await backfillDocuments(mockEnv);

    expect(result.success).toBe(true);
    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("reports failures", async () => {
    const { indexDocument } = await import("../embeddings");
    vi.mocked(indexDocument)
      .mockResolvedValueOnce({ success: true, chunksIndexed: 1, message: "ok" })
      .mockResolvedValueOnce({ success: false, chunksIndexed: 0, message: "Vector error" });

    await addDocument(mockEnv, "Doc 1", "content 1", "U123");
    await addDocument(mockEnv, "Doc 2", "content 2", "U123");

    vi.clearAllMocks();
    vi.mocked(indexDocument)
      .mockResolvedValueOnce({ success: true, chunksIndexed: 1, message: "ok" })
      .mockResolvedValueOnce({ success: false, chunksIndexed: 0, message: "Vector error" });

    const result = await backfillDocuments(mockEnv);

    expect(result.success).toBe(false);
    expect(result.indexed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.message).toContain("Vector error");
  });

  it("handles missing content", async () => {
    // Add doc to index without content
    mockKV._store.set("docs:index", JSON.stringify({
      documents: [{ title: "Missing", addedBy: "U123", addedAt: "2024-01-01", charCount: 100 }],
    }));

    const result = await backfillDocuments(mockEnv);

    expect(result.failed).toBe(1);
    expect(result.message).toContain("content not found");
  });
});

describe("getRandomDocument", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockKV);
    vi.clearAllMocks();
  });

  it("returns error when knowledge base is empty", async () => {
    const result = await getRandomDocument(mockEnv);

    expect(result.success).toBe(false);
    expect(result.message).toContain("empty");
  });

  it("returns a random document from the knowledge base", async () => {
    await addDocument(mockEnv, "Doc One", "Content for doc one", "U123");
    await addDocument(mockEnv, "Doc Two", "Content for doc two", "U456");

    const result = await getRandomDocument(mockEnv);

    expect(result.success).toBe(true);
    expect(result.title).toBeDefined();
    expect(result.content).toBeDefined();
    expect(["Doc One", "Doc Two"]).toContain(result.title);
    expect(result.message).toContain("🎲");
    expect(result.message).toContain(result.title!);
  });

  it("returns the only document when knowledge base has one", async () => {
    await addDocument(mockEnv, "Only Doc", "The only content", "U123");

    const result = await getRandomDocument(mockEnv);

    expect(result.success).toBe(true);
    expect(result.title).toBe("Only Doc");
    expect(result.content).toBe("The only content");
  });

  it("handles missing content gracefully", async () => {
    // Corrupt the index - add entry without content
    mockKV._store.set("docs:index", JSON.stringify({
      documents: [{ title: "Ghost Doc", addedBy: "U123", addedAt: "2024-01-01", charCount: 100 }],
    }));

    const result = await getRandomDocument(mockEnv);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Couldn't retrieve");
  });
});

describe("backfillIfNeeded", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = createMockKV();
    mockEnv = {
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "secret",
      ANTHROPIC_API_KEY: "key",
      HONEYCOMB_API_KEY: "honey",
      DOCS_KV: mockKV as unknown as KVNamespace,
      VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
      AI: { run: vi.fn() } as unknown as Ai,
    };
  });

  it("skips backfill if last backfill was recent", async () => {
    // Set last backfill to 1 hour ago (within 24 hour threshold)
    const recentBackfill = Date.now() - 60 * 60 * 1000;
    mockKV._store.set("sync:backfill:last", recentBackfill.toString());

    const result = await backfillIfNeeded(mockEnv);

    expect(result).toBe(false);
  });

  it("performs backfill if last backfill was long ago", async () => {
    // Set last backfill to 25 hours ago (beyond 24 hour threshold)
    const oldBackfill = Date.now() - 25 * 60 * 60 * 1000;
    mockKV._store.set("sync:backfill:last", oldBackfill.toString());

    const result = await backfillIfNeeded(mockEnv);

    expect(result).toBe(true);
  });

  it("performs backfill if never done before", async () => {
    const result = await backfillIfNeeded(mockEnv);

    expect(result).toBe(true);
  });

  it("records backfill timestamp on success", async () => {
    await backfillIfNeeded(mockEnv);

    const stored = mockKV._store.get("sync:backfill:last");
    expect(stored).toBeDefined();
    const backfillTime = parseInt(stored!, 10);
    expect(Date.now() - backfillTime).toBeLessThan(5000);
  });
});
