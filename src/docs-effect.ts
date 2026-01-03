/**
 * Effect-based document management with typed errors and service pattern
 */

import { Effect, Context, Option, pipe } from "effect";

// Constants
const DOCS_INDEX_KEY = "docs:index";
const DOCS_PREFIX = "docs:content:";
const MAX_DOC_SIZE = 50000;
const MAX_TOTAL_KB_SIZE = 200000;
const MAX_TITLE_LENGTH = 100;

// Typed error classes

export class EmptyTitleError extends Error {
  readonly _tag = "EmptyTitleError" as const;
  constructor() {
    super("Title cannot be empty");
    this.name = "EmptyTitleError";
  }
}

export class TitleTooLongError extends Error {
  readonly _tag = "TitleTooLongError" as const;
  constructor(
    public readonly length: number,
    public readonly maxLength: number
  ) {
    super(`Title too long (${length} chars). Max is ${maxLength} chars.`);
    this.name = "TitleTooLongError";
  }
}

export class DocumentTooLargeError extends Error {
  readonly _tag = "DocumentTooLargeError" as const;
  constructor(
    public readonly size: number,
    public readonly maxSize: number
  ) {
    super(`Document too large (${size} chars). Max size is ${maxSize} chars.`);
    this.name = "DocumentTooLargeError";
  }
}

export class KnowledgeBaseFullError extends Error {
  readonly _tag = "KnowledgeBaseFullError" as const;
  constructor(
    public readonly currentSize: number,
    public readonly maxSize: number
  ) {
    super(
      `Knowledge base full. Current: ${currentSize} chars, limit: ${maxSize} chars.`
    );
    this.name = "KnowledgeBaseFullError";
  }
}

export class DuplicateTitleError extends Error {
  readonly _tag = "DuplicateTitleError" as const;
  constructor(public readonly title: string) {
    super(`A document titled "${title}" already exists.`);
    this.name = "DuplicateTitleError";
  }
}

export class DocumentNotFoundError extends Error {
  readonly _tag = "DocumentNotFoundError" as const;
  constructor(public readonly title: string) {
    super(`No document titled "${title}" found.`);
    this.name = "DocumentNotFoundError";
  }
}

export class InvalidTitleError extends Error {
  readonly _tag = "InvalidTitleError" as const;
  constructor(public readonly title: string) {
    super(`Invalid title: "${title}" results in empty key after sanitization`);
    this.name = "InvalidTitleError";
  }
}

export type DocsError =
  | EmptyTitleError
  | TitleTooLongError
  | DocumentTooLargeError
  | KnowledgeBaseFullError
  | DuplicateTitleError
  | DocumentNotFoundError
  | InvalidTitleError;

// Service definitions

export interface KVServiceConfig {
  readonly get: (key: string) => Promise<string | null>;
  readonly put: (key: string, value: string) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

export class KVService extends Context.Tag("KVService")<
  KVService,
  KVServiceConfig
>() {}

export class DocsService extends Context.Tag("DocsService")<
  DocsService,
  { readonly kv: KVServiceConfig }
>() {}

// Types

interface DocMetadata {
  title: string;
  addedBy: string;
  addedAt: string;
  charCount: number;
}

interface DocsIndex {
  documents: DocMetadata[];
}

// Helpers

function sanitizeTitle(title: string): string {
  return title
    .slice(0, MAX_TITLE_LENGTH)
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function titleToKey(title: string): Effect.Effect<string, InvalidTitleError> {
  const sanitized = sanitizeTitle(title);
  if (!sanitized) {
    return Effect.fail(new InvalidTitleError(title));
  }
  return Effect.succeed(DOCS_PREFIX + sanitized);
}

function getIndex(): Effect.Effect<DocsIndex, never, KVService> {
  return Effect.gen(function* () {
    const kv = yield* KVService;
    const data = yield* Effect.promise(() => kv.get(DOCS_INDEX_KEY));
    if (!data) {
      return { documents: [] };
    }
    return JSON.parse(data) as DocsIndex;
  });
}

function saveIndex(index: DocsIndex): Effect.Effect<void, never, KVService> {
  return Effect.gen(function* () {
    const kv = yield* KVService;
    yield* Effect.promise(() => kv.put(DOCS_INDEX_KEY, JSON.stringify(index)));
  });
}

// Main functions

export function addDocumentEffect(
  title: string,
  content: string,
  addedBy: string
): Effect.Effect<
  { success: boolean; message: string },
  DocsError,
  KVService
> {
  return Effect.gen(function* () {
    const kv = yield* KVService;

    // Validate title
    if (!title || title.trim().length === 0) {
      return yield* Effect.fail(new EmptyTitleError());
    }

    if (title.length > MAX_TITLE_LENGTH) {
      return yield* Effect.fail(
        new TitleTooLongError(title.length, MAX_TITLE_LENGTH)
      );
    }

    // Validate content size
    if (content.length > MAX_DOC_SIZE) {
      return yield* Effect.fail(
        new DocumentTooLargeError(content.length, MAX_DOC_SIZE)
      );
    }

    const index = yield* getIndex();

    // Check total knowledge base size
    const currentTotal = index.documents.reduce((sum, d) => sum + d.charCount, 0);
    if (currentTotal + content.length > MAX_TOTAL_KB_SIZE) {
      return yield* Effect.fail(
        new KnowledgeBaseFullError(currentTotal, MAX_TOTAL_KB_SIZE)
      );
    }

    // Check for duplicate title
    const existing = index.documents.find(
      (d) => d.title.toLowerCase() === title.toLowerCase()
    );
    if (existing) {
      return yield* Effect.fail(new DuplicateTitleError(title));
    }

    // Generate KV key
    const key = yield* titleToKey(title);

    // Store content
    yield* Effect.promise(() => kv.put(key, content));

    // Update index
    index.documents.push({
      title,
      addedBy,
      addedAt: new Date().toISOString(),
      charCount: content.length,
    });
    yield* saveIndex(index);

    // Note: In a full implementation, semantic indexing would be handled
    // via a separate Effect with its own service. For now, we skip it
    // in the Effect version since it requires the full Env.

    return {
      success: true,
      message: `Added "${title}" (${content.length} chars) to the knowledge base.`,
    };
  });
}

export function removeDocumentEffect(
  title: string
): Effect.Effect<
  { success: boolean; message: string },
  DocumentNotFoundError | InvalidTitleError,
  KVService
> {
  return Effect.gen(function* () {
    const kv = yield* KVService;
    const index = yield* getIndex();

    const docIndex = index.documents.findIndex(
      (d) => d.title.toLowerCase() === title.toLowerCase()
    );

    if (docIndex === -1) {
      return yield* Effect.fail(new DocumentNotFoundError(title));
    }

    const removed = index.documents[docIndex];
    const key = yield* titleToKey(removed.title);

    yield* Effect.promise(() => kv.delete(key));

    index.documents.splice(docIndex, 1);
    yield* saveIndex(index);

    // Note: Vector index removal would be handled via separate Effect service

    return {
      success: true,
      message: `Removed "${removed.title}" from the knowledge base.`,
    };
  });
}

export function listDocumentsEffect(
  pagination?: { page?: number; pageSize?: number }
): Effect.Effect<string, never, KVService> {
  return Effect.gen(function* () {
    const index = yield* getIndex();

    if (index.documents.length === 0) {
      return "The knowledge base is empty. Add documents with:\n`@Chorus add doc \"Title\": Your content here...`";
    }

    const totalItems = index.documents.length;
    const page = Math.max(1, pagination?.page ?? 1);
    const pageSize = Math.max(1, Math.min(50, pagination?.pageSize ?? 10));
    const totalPages = Math.ceil(totalItems / pageSize);

    const startIndex = (page - 1) * pageSize;
    const paginatedDocs = index.documents.slice(startIndex, startIndex + pageSize);
    const hasMore = page < totalPages;

    const lines = paginatedDocs.map((doc) => {
      const date = new Date(doc.addedAt).toLocaleDateString();
      return `• *${doc.title}* (${doc.charCount} chars, added ${date})`;
    });

    const headerParts = ["*Knowledge Base*"];
    if (totalPages > 1) {
      headerParts.push(`(page ${page}/${totalPages}, ${totalItems} docs)`);
    } else {
      headerParts.push(`(${totalItems} docs)`);
    }

    let result = `${headerParts.join(" ")}\n\n${lines.join("\n")}`;

    if (hasMore) {
      result += `\n\n_Use \`docs --page ${page + 1}\` for more_`;
    }

    return result;
  });
}

export function getKnowledgeBaseEffect(): Effect.Effect<
  Option.Option<string>,
  never,
  KVService
> {
  return Effect.gen(function* () {
    const kv = yield* KVService;
    const index = yield* getIndex();

    if (index.documents.length === 0) {
      return Option.none();
    }

    const contents = yield* Effect.all(
      index.documents.map((meta) =>
        pipe(
          Effect.try(() => titleToKey(meta.title)),
          Effect.flatMap((keyEffect) => keyEffect),
          Effect.flatMap((key) =>
            Effect.promise(() => kv.get(key))
          ),
          Effect.map((content) => ({ title: meta.title, content })),
          Effect.catchAll(() => Effect.succeed({ title: meta.title, content: null }))
        )
      )
    );

    const docs = contents
      .filter((r) => r.content !== null)
      .map((r) => `## ${r.title}\n\n${r.content}`);

    if (docs.length === 0) {
      return Option.none();
    }

    return Option.some(docs.join("\n\n---\n\n"));
  });
}

export function getRandomDocumentEffect(): Effect.Effect<
  Option.Option<{ title: string; content: string }>,
  never,
  KVService
> {
  return Effect.gen(function* () {
    const kv = yield* KVService;
    const index = yield* getIndex();

    if (index.documents.length === 0) {
      return Option.none();
    }

    const randomIndex = Math.floor(Math.random() * index.documents.length);
    const doc = index.documents[randomIndex];

    const keyResult = yield* pipe(
      titleToKey(doc.title),
      Effect.catchAll(() => Effect.succeed(""))
    );

    if (!keyResult) {
      return Option.none();
    }

    const content = yield* Effect.promise(() => kv.get(keyResult));

    if (!content) {
      return Option.none();
    }

    return Option.some({ title: doc.title, content });
  });
}
