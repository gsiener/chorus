import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Exit, Cause, Layer } from "effect";

// These imports will fail initially - expected (RED phase)
import {
  DocsService,
  KVService,
  EmptyTitleError,
  TitleTooLongError,
  DocumentTooLargeError,
  KnowledgeBaseFullError,
  DuplicateTitleError,
  DocumentNotFoundError,
  InvalidTitleError,
  addDocumentEffect,
  removeDocumentEffect,
  listDocumentsEffect,
  getKnowledgeBaseEffect,
  getRandomDocumentEffect,
} from "../docs-effect";

// Mock embeddings module
vi.mock("../embeddings", () => ({
  indexDocument: vi
    .fn()
    .mockResolvedValue({ success: true, chunksIndexed: 1, message: "Indexed" }),
  removeDocumentFromIndex: vi
    .fn()
    .mockResolvedValue({ success: true, message: "Removed" }),
}));

function createMockKVStore() {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
    _store: store,
  };
}

describe("docs-effect", () => {
  let mockKV: ReturnType<typeof createMockKVStore>;
  let TestDocsLayer: Layer.Layer<KVService>;

  beforeEach(() => {
    mockKV = createMockKVStore();
    TestDocsLayer = Layer.succeed(KVService, {
      get: mockKV.get,
      put: mockKV.put,
      delete: mockKV.delete,
    });
    vi.clearAllMocks();
  });

  describe("addDocumentEffect", () => {
    it("adds a document successfully", async () => {
      const effect = addDocumentEffect("Test Doc", "Test content here", "U123");
      const result = await Effect.runPromise(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("Test Doc");

      // Verify stored in KV
      expect(mockKV._store.get("docs:content:test-doc")).toBe(
        "Test content here"
      );
    });

    it("fails with EmptyTitleError for empty title", async () => {
      const effect = addDocumentEffect("", "content", "U123");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(EmptyTitleError);
        }
      }
    });

    it("fails with EmptyTitleError for whitespace-only title", async () => {
      const effect = addDocumentEffect("   ", "content", "U123");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(EmptyTitleError);
        }
      }
    });

    it("fails with TitleTooLongError for title exceeding max length", async () => {
      const longTitle = "a".repeat(101);
      const effect = addDocumentEffect(longTitle, "content", "U123");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(TitleTooLongError);
          expect((error.value as TitleTooLongError).maxLength).toBe(100);
        }
      }
    });

    it("fails with DocumentTooLargeError for oversized content", async () => {
      const largeContent = "x".repeat(50001);
      const effect = addDocumentEffect("Test", largeContent, "U123");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(DocumentTooLargeError);
          expect((error.value as DocumentTooLargeError).size).toBe(50001);
        }
      }
    });

    it("fails with DuplicateTitleError for duplicate titles", async () => {
      const addFirst = addDocumentEffect("My Document", "content 1", "U123");
      await Effect.runPromise(Effect.provide(addFirst, TestDocsLayer));

      const addSecond = addDocumentEffect("my document", "content 2", "U456");
      const exit = await Effect.runPromiseExit(
        Effect.provide(addSecond, TestDocsLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(DuplicateTitleError);
          expect((error.value as DuplicateTitleError).title).toBe("my document");
        }
      }
    });

    it("fails with KnowledgeBaseFullError when KB is full", async () => {
      // Add 4 docs at 49000 chars each = 196000 chars total
      for (let i = 0; i < 4; i++) {
        const add = addDocumentEffect(`Doc ${i}`, "x".repeat(49000), "U123");
        await Effect.runPromise(Effect.provide(add, TestDocsLayer));
      }

      // Try to exceed 200000 limit
      const add = addDocumentEffect("Another", "x".repeat(10000), "U123");
      const exit = await Effect.runPromiseExit(
        Effect.provide(add, TestDocsLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(KnowledgeBaseFullError);
        }
      }
    });

    it("fails with InvalidTitleError for title with only special chars", async () => {
      const effect = addDocumentEffect("!@#$%", "content", "U123");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(InvalidTitleError);
        }
      }
    });

    it("sanitizes title for KV key", async () => {
      const effect = addDocumentEffect("Test Doc!@#$%", "content", "U123");
      await Effect.runPromise(Effect.provide(effect, TestDocsLayer));

      expect(mockKV._store.has("docs:content:test-doc")).toBe(true);
    });
  });

  describe("removeDocumentEffect", () => {
    it("removes existing document", async () => {
      const add = addDocumentEffect("To Remove", "content", "U123");
      await Effect.runPromise(Effect.provide(add, TestDocsLayer));

      const remove = removeDocumentEffect("To Remove");
      const result = await Effect.runPromise(
        Effect.provide(remove, TestDocsLayer)
      );

      expect(result.success).toBe(true);
      expect(mockKV._store.has("docs:content:to-remove")).toBe(false);
    });

    it("removes document case-insensitively", async () => {
      const add = addDocumentEffect("My Document", "content", "U123");
      await Effect.runPromise(Effect.provide(add, TestDocsLayer));

      const remove = removeDocumentEffect("MY DOCUMENT");
      const result = await Effect.runPromise(
        Effect.provide(remove, TestDocsLayer)
      );

      expect(result.success).toBe(true);
    });

    it("fails with DocumentNotFoundError for non-existent document", async () => {
      const effect = removeDocumentEffect("Does Not Exist");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(DocumentNotFoundError);
          expect((error.value as DocumentNotFoundError).title).toBe(
            "Does Not Exist"
          );
        }
      }
    });
  });

  describe("listDocumentsEffect", () => {
    it("returns empty message when no documents", async () => {
      const effect = listDocumentsEffect();
      const result = await Effect.runPromise(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(result).toContain("empty");
    });

    it("lists all documents with metadata", async () => {
      const add1 = addDocumentEffect("Doc One", "content one", "U123");
      const add2 = addDocumentEffect("Doc Two", "longer content here", "U456");
      await Effect.runPromise(Effect.provide(add1, TestDocsLayer));
      await Effect.runPromise(Effect.provide(add2, TestDocsLayer));

      const effect = listDocumentsEffect();
      const result = await Effect.runPromise(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(result).toContain("Doc One");
      expect(result).toContain("Doc Two");
      expect(result).toContain("2 docs");
    });
  });

  describe("getKnowledgeBaseEffect", () => {
    it("returns None when no documents", async () => {
      const effect = getKnowledgeBaseEffect();
      const result = await Effect.runPromise(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(result._tag).toBe("None");
    });

    it("returns Some with formatted knowledge base", async () => {
      const add1 = addDocumentEffect("Strategy", "Our strategy is...", "U123");
      const add2 = addDocumentEffect("Roadmap", "Q1 priorities...", "U456");
      await Effect.runPromise(Effect.provide(add1, TestDocsLayer));
      await Effect.runPromise(Effect.provide(add2, TestDocsLayer));

      const effect = getKnowledgeBaseEffect();
      const result = await Effect.runPromise(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(result._tag).toBe("Some");
      if (result._tag === "Some") {
        expect(result.value).toContain("## Strategy");
        expect(result.value).toContain("## Roadmap");
      }
    });
  });

  describe("getRandomDocumentEffect", () => {
    it("returns None when knowledge base is empty", async () => {
      const effect = getRandomDocumentEffect();
      const result = await Effect.runPromise(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(result._tag).toBe("None");
    });

    it("returns Some with a random document", async () => {
      const add1 = addDocumentEffect("Doc One", "Content one", "U123");
      const add2 = addDocumentEffect("Doc Two", "Content two", "U456");
      await Effect.runPromise(Effect.provide(add1, TestDocsLayer));
      await Effect.runPromise(Effect.provide(add2, TestDocsLayer));

      const effect = getRandomDocumentEffect();
      const result = await Effect.runPromise(
        Effect.provide(effect, TestDocsLayer)
      );

      expect(result._tag).toBe("Some");
      if (result._tag === "Some") {
        expect(["Doc One", "Doc Two"]).toContain(result.value.title);
      }
    });
  });

  describe("typed errors", () => {
    it("EmptyTitleError has correct tag", () => {
      const error = new EmptyTitleError();
      expect(error._tag).toBe("EmptyTitleError");
    });

    it("TitleTooLongError has maxLength", () => {
      const error = new TitleTooLongError(150, 100);
      expect(error._tag).toBe("TitleTooLongError");
      expect(error.length).toBe(150);
      expect(error.maxLength).toBe(100);
    });

    it("DocumentTooLargeError has size and maxSize", () => {
      const error = new DocumentTooLargeError(60000, 50000);
      expect(error._tag).toBe("DocumentTooLargeError");
      expect(error.size).toBe(60000);
      expect(error.maxSize).toBe(50000);
    });

    it("KnowledgeBaseFullError has currentSize and maxSize", () => {
      const error = new KnowledgeBaseFullError(200000, 200000);
      expect(error._tag).toBe("KnowledgeBaseFullError");
    });

    it("DuplicateTitleError has title", () => {
      const error = new DuplicateTitleError("My Doc");
      expect(error._tag).toBe("DuplicateTitleError");
      expect(error.title).toBe("My Doc");
    });

    it("DocumentNotFoundError has title", () => {
      const error = new DocumentNotFoundError("Missing");
      expect(error._tag).toBe("DocumentNotFoundError");
      expect(error.title).toBe("Missing");
    });

    it("InvalidTitleError has title", () => {
      const error = new InvalidTitleError("!@#");
      expect(error._tag).toBe("InvalidTitleError");
      expect(error.title).toBe("!@#");
    });
  });
});
