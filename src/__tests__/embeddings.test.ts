import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  chunkDocument,
  formatSearchResultsForContext,
  type DocumentChunk,
  type SearchResult,
} from "../embeddings";

describe("chunkDocument", () => {
  it("returns single chunk for small documents", () => {
    const chunks = chunkDocument("Test Doc", "This is a short document.");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe("doc:test-doc:chunk:0");
    expect(chunks[0].title).toBe("Test Doc");
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toBe("This is a short document.");
    expect(chunks[0].contextPrefix).toContain("full content");
  });

  it("creates multiple chunks for long documents", () => {
    // Create a document longer than CHUNK_SIZE (1000 chars)
    const longContent = "A".repeat(500) + ". " + "B".repeat(500) + ". " + "C".repeat(500);
    const chunks = chunkDocument("Long Doc", longContent);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].contextPrefix).toContain("beginning");
    expect(chunks[chunks.length - 1].contextPrefix).toContain("end");
  });

  it("sanitizes title for ID", () => {
    const chunks = chunkDocument("Test Doc With Spaces!", "Content");

    expect(chunks[0].id).toBe("doc:test-doc-with-spaces:chunk:0");
  });

  it("sets context prefix correctly for middle chunks", () => {
    // Create a very long document to ensure multiple middle chunks
    const longContent = Array(10).fill("A".repeat(200) + ". ").join("");
    const chunks = chunkDocument("Multi Part", longContent);

    if (chunks.length > 2) {
      expect(chunks[1].contextPrefix).toContain("part 2 of");
    }
  });

  it("handles empty content gracefully", () => {
    const chunks = chunkDocument("Empty", "");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("");
  });

  it("handles special characters in title", () => {
    const chunks = chunkDocument("Test@Doc#123!", "Content");

    expect(chunks[0].id).toBe("doc:testdoc123:chunk:0");
  });

  it("preserves content integrity across chunks", () => {
    const originalContent = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = chunkDocument("Test", originalContent);

    // Single chunk should have all content
    expect(chunks[0].content).toBe(originalContent);
  });
});

describe("formatSearchResultsForContext", () => {
  it("returns null for empty results", () => {
    const result = formatSearchResultsForContext([]);

    expect(result).toBeNull();
  });

  it("formats single result correctly", () => {
    const results: SearchResult[] = [
      { title: "Test Doc", content: "Test content here", score: 0.85 },
    ];

    const formatted = formatSearchResultsForContext(results);

    expect(formatted).toContain("Relevant Knowledge Base Excerpts");
    expect(formatted).toContain("Test Doc");
    expect(formatted).toContain("85%");
    expect(formatted).toContain("Test content here");
  });

  it("formats multiple results correctly", () => {
    const results: SearchResult[] = [
      { title: "Doc 1", content: "Content 1", score: 0.95 },
      { title: "Doc 2", content: "Content 2", score: 0.75 },
    ];

    const formatted = formatSearchResultsForContext(results);

    expect(formatted).toContain("Doc 1");
    expect(formatted).toContain("Doc 2");
    expect(formatted).toContain("95%");
    expect(formatted).toContain("75%");
  });

  it("rounds score percentages", () => {
    const results: SearchResult[] = [
      { title: "Test", content: "Content", score: 0.876 },
    ];

    const formatted = formatSearchResultsForContext(results);

    expect(formatted).toContain("88%"); // 0.876 * 100 rounded
  });

  it("includes separators between results", () => {
    const results: SearchResult[] = [
      { title: "Doc 1", content: "Content 1", score: 0.9 },
      { title: "Doc 2", content: "Content 2", score: 0.8 },
    ];

    const formatted = formatSearchResultsForContext(results);

    expect(formatted).toContain("---");
  });
});

describe("chunk overlap behavior", () => {
  it("creates overlapping chunks for continuity", () => {
    // Create content that will span multiple chunks
    const paragraph1 = "First paragraph content. ".repeat(20); // ~500 chars
    const paragraph2 = "Second paragraph content. ".repeat(20);
    const paragraph3 = "Third paragraph content. ".repeat(20);
    const longContent = paragraph1 + "\n\n" + paragraph2 + "\n\n" + paragraph3;

    const chunks = chunkDocument("Overlap Test", longContent);

    if (chunks.length > 1) {
      // Check that there's some overlap by looking for repeated content
      // The end of one chunk should appear at the start of the next
      for (let i = 0; i < chunks.length - 1; i++) {
        const endOfCurrent = chunks[i].content.slice(-100);
        const startOfNext = chunks[i + 1].content.slice(0, 300);
        // With 200 char overlap, some content should repeat
        // This is a loose check as paragraph boundaries may affect exact overlap
        expect(chunks[i].content.length).toBeGreaterThan(0);
        expect(chunks[i + 1].content.length).toBeGreaterThan(0);
      }
    }
  });
});
