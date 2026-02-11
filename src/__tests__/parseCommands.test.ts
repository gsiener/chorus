import { describe, it, expect } from "vitest";
import { parseDocCommand, parseSearchCommand, parseCheckInCommand } from "../parseCommands";

describe("parseDocCommand", () => {
  const botUserId = "U123BOT";

  it("parses 'docs' as list command", () => {
    const result = parseDocCommand(`<@${botUserId}> docs`, botUserId);
    expect(result).toEqual({ type: "list" });
  });

  it("parses 'list docs' as list command", () => {
    const result = parseDocCommand(`<@${botUserId}> list docs`, botUserId);
    expect(result).toEqual({ type: "list" });
  });

  it("parses 'docs --page 2' as list command with page", () => {
    const result = parseDocCommand(`<@${botUserId}> docs --page 2`, botUserId);
    expect(result).toEqual({ type: "list", page: 2 });
  });

  it("parses 'backfill docs' as backfill command", () => {
    const result = parseDocCommand(`<@${botUserId}> backfill docs`, botUserId);
    expect(result).toEqual({ type: "backfill" });
  });

  it("parses add doc command", () => {
    const result = parseDocCommand(`<@${botUserId}> add doc "Test Title": some content`, botUserId);
    expect(result).toEqual({ type: "add", title: "Test Title", content: "some content" });
  });

  it("parses update doc command", () => {
    const result = parseDocCommand(`<@${botUserId}> update doc "Test Title": new content`, botUserId);
    expect(result).toEqual({ type: "update", title: "Test Title", content: "new content" });
  });

  it("parses remove doc command", () => {
    const result = parseDocCommand(`<@${botUserId}> remove doc "Test Title"`, botUserId);
    expect(result).toEqual({ type: "remove", title: "Test Title" });
  });

  it("returns null for non-doc commands", () => {
    const result = parseDocCommand(`<@${botUserId}> hello world`, botUserId);
    expect(result).toBeNull();
  });
});

describe("parseSearchCommand", () => {
  const botUserId = "U123BOT";

  it("parses search with quoted query", () => {
    const result = parseSearchCommand(`<@${botUserId}> search "roadmap"`, botUserId);
    expect(result).toEqual({ query: "roadmap" });
  });

  it("parses search with unquoted query", () => {
    const result = parseSearchCommand(`<@${botUserId}> search roadmap planning`, botUserId);
    expect(result).toEqual({ query: "roadmap planning" });
  });

  it("returns null for non-search commands", () => {
    const result = parseSearchCommand(`<@${botUserId}> hello world`, botUserId);
    expect(result).toBeNull();
  });
});

describe("parseCheckInCommand", () => {
  const botUserId = "U123BOT";

  it("parses 'checkin history'", () => {
    const result = parseCheckInCommand(`<@${botUserId}> checkin history`, botUserId);
    expect(result).toEqual({ type: "history" });
  });

  it("parses 'check-in history --limit 5'", () => {
    const result = parseCheckInCommand(`<@${botUserId}> check-in history --limit 5`, botUserId);
    expect(result).toEqual({ type: "history", limit: 5 });
  });

  it("returns null for non-checkin commands", () => {
    const result = parseCheckInCommand(`<@${botUserId}> hello world`, botUserId);
    expect(result).toBeNull();
  });
});
