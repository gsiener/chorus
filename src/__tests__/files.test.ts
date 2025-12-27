import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractFileContent, titleFromFilename } from "../files";
import type { Env, SlackFile } from "../types";

function createMockEnv(): Env {
  return {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: {} as KVNamespace,
    VECTORIZE: {} as VectorizeIndex,
    AI: {} as Ai,
  };
}

function createMockFile(overrides: Partial<SlackFile> = {}): SlackFile {
  return {
    id: "F123",
    name: "test.txt",
    mimetype: "text/plain",
    filetype: "txt",
    size: 100,
    url_private: "https://files.slack.com/test.txt",
    url_private_download: "https://files.slack.com/download/test.txt",
    ...overrides,
  };
}

describe("titleFromFilename", () => {
  it("removes single extension", () => {
    expect(titleFromFilename("document.txt")).toBe("document");
  });

  it("removes only last extension", () => {
    expect(titleFromFilename("archive.tar.gz")).toBe("archive.tar");
  });

  it("handles files with no extension", () => {
    expect(titleFromFilename("README")).toBe("README");
  });

  it("handles files with dots in name", () => {
    expect(titleFromFilename("version.1.0.pdf")).toBe("version.1.0");
  });

  it("handles empty string", () => {
    expect(titleFromFilename("")).toBe("");
  });

  it("handles file starting with dot", () => {
    expect(titleFromFilename(".gitignore")).toBe("");
  });
});

describe("extractFileContent", () => {
  let mockEnv: Env;

  beforeEach(() => {
    mockEnv = createMockEnv();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts content from text file", async () => {
    const file = createMockFile({
      name: "notes.txt",
      mimetype: "text/plain",
      size: 100,
    });

    const textContent = "Hello, this is a text file.";
    const encoder = new TextEncoder();
    const buffer = encoder.encode(textContent);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(buffer, { status: 200 })
    );

    const result = await extractFileContent(file, mockEnv);

    expect(result).not.toBeNull();
    expect(result?.filename).toBe("notes.txt");
    expect(result?.content).toBe("Hello, this is a text file.");
    expect(result?.charCount).toBe(27);
  });

  it("extracts content from markdown file", async () => {
    const file = createMockFile({
      name: "README.md",
      mimetype: "text/markdown",
      size: 50,
    });

    const content = "# Title\n\nSome markdown content";
    const encoder = new TextEncoder();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(encoder.encode(content), { status: 200 })
    );

    const result = await extractFileContent(file, mockEnv);

    expect(result?.content).toBe("# Title\n\nSome markdown content");
  });

  it("extracts content from JSON file", async () => {
    const file = createMockFile({
      name: "config.json",
      mimetype: "application/json",
      size: 30,
    });

    const content = '{"key": "value"}';
    const encoder = new TextEncoder();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(encoder.encode(content), { status: 200 })
    );

    const result = await extractFileContent(file, mockEnv);

    expect(result?.content).toBe('{"key": "value"}');
  });

  it("returns null for unsupported file types", async () => {
    const file = createMockFile({
      name: "image.png",
      mimetype: "image/png",
      filetype: "png",
    });

    const result = await extractFileContent(file, mockEnv);

    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws error for PDF files with guidance message", async () => {
    const file = createMockFile({
      name: "document.pdf",
      mimetype: "application/pdf",
      filetype: "pdf",
    });

    await expect(extractFileContent(file, mockEnv)).rejects.toThrow(
      "PDF upload not supported yet"
    );
  });

  it("throws error when file is too large", async () => {
    const file = createMockFile({
      size: 2 * 1024 * 1024, // 2MB
    });

    await expect(extractFileContent(file, mockEnv)).rejects.toThrow(
      "File too large"
    );
  });

  it("throws error on download failure", async () => {
    const file = createMockFile();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 403 })
    );

    await expect(extractFileContent(file, mockEnv)).rejects.toThrow(
      "Failed to download file: 403"
    );
  });

  it("trims whitespace from extracted content", async () => {
    const file = createMockFile();

    const content = "  \n  Content with whitespace  \n  ";
    const encoder = new TextEncoder();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(encoder.encode(content), { status: 200 })
    );

    const result = await extractFileContent(file, mockEnv);

    expect(result?.content).toBe("Content with whitespace");
  });

  it("returns null for empty file content", async () => {
    const file = createMockFile();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(new TextEncoder().encode("   "), { status: 200 })
    );

    const result = await extractFileContent(file, mockEnv);

    expect(result).toBeNull();
  });

  it("follows redirects with auth header", async () => {
    const file = createMockFile();
    const content = "Final content";
    const encoder = new TextEncoder();

    // First response is a redirect
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://files.slack.com/actual-file" },
        })
      )
      .mockResolvedValueOnce(
        new Response(encoder.encode(content), { status: 200 })
      );

    const result = await extractFileContent(file, mockEnv);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result?.content).toBe("Final content");
  });

  it("detects HTML auth redirect error", async () => {
    const file = createMockFile();

    const htmlResponse = "<!DOCTYPE html><html>Login required</html>";
    const encoder = new TextEncoder();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(encoder.encode(htmlResponse), { status: 200 })
    );

    await expect(extractFileContent(file, mockEnv)).rejects.toThrow(
      "Got HTML instead of file - auth may have failed"
    );
  });

  it("handles CSV files", async () => {
    const file = createMockFile({
      name: "data.csv",
      mimetype: "text/csv",
      filetype: "csv",
    });

    const content = "name,value\nfoo,1\nbar,2";
    const encoder = new TextEncoder();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(encoder.encode(content), { status: 200 })
    );

    const result = await extractFileContent(file, mockEnv);

    expect(result?.content).toBe("name,value\nfoo,1\nbar,2");
  });
});
