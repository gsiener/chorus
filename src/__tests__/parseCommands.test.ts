import { describe, it, expect } from "vitest";
import { parseInitiativeCommand } from "../parseCommands";
import { mightBeInitiativeCommand } from "../initiative-nlp";

describe("parseInitiativeCommand", () => {
  const botUserId = "U123BOT";

  describe("explicit commands should be parsed", () => {
    it("parses 'initiatives' as list command", () => {
      const result = parseInitiativeCommand(`<@${botUserId}> initiatives`, botUserId);
      expect(result).toEqual({ type: "list" });
    });

    it("parses 'initiatives --mine' as filtered list", () => {
      const result = parseInitiativeCommand(`<@${botUserId}> initiatives --mine`, botUserId);
      expect(result).toEqual({ type: "list", filters: { owner: "__CURRENT_USER__" } });
    });

    it("parses 'initiatives sync linear' as sync command", () => {
      const result = parseInitiativeCommand(`<@${botUserId}> initiatives sync linear`, botUserId);
      expect(result).toEqual({ type: "sync-linear" });
    });
  });

  describe("natural language questions should NOT be parsed (PDD-65)", () => {
    it("does NOT parse 'can you list all the initiatives?'", () => {
      const result = parseInitiativeCommand(
        `<@${botUserId}> can you list all the initiatives?`,
        botUserId
      );
      expect(result).toBeNull();
    });

    it("does NOT parse 'what are our initiatives?'", () => {
      const result = parseInitiativeCommand(
        `<@${botUserId}> what are our initiatives?`,
        botUserId
      );
      expect(result).toBeNull();
    });

    it("does NOT parse 'tell me about the initiatives'", () => {
      const result = parseInitiativeCommand(
        `<@${botUserId}> tell me about the initiatives`,
        botUserId
      );
      expect(result).toBeNull();
    });

    it("does NOT parse 'list all the initiatives please'", () => {
      const result = parseInitiativeCommand(
        `<@${botUserId}> list all the initiatives please`,
        botUserId
      );
      expect(result).toBeNull();
    });

    it("does NOT parse 'show me initiatives'", () => {
      const result = parseInitiativeCommand(
        `<@${botUserId}> show me initiatives`,
        botUserId
      );
      expect(result).toBeNull();
    });
  });
});

describe("mightBeInitiativeCommand (PDD-65)", () => {
  // NOTE: NLP initiative commands are DISABLED (always returns false)
  // This ensures all initiative queries go to Claude, which uses R&D Priorities.
  // See initiative-nlp.ts for details.
  describe("always returns false (NLP disabled for PDD-65 fix)", () => {
    it("returns false for 'mark Project X as active'", () => {
      expect(mightBeInitiativeCommand("mark Project X as active")).toBe(false);
    });

    it("returns false for 'set status of Project X to completed'", () => {
      expect(mightBeInitiativeCommand("set status of Project X to completed")).toBe(false);
    });

    it("returns false for 'add metric to Project X'", () => {
      expect(mightBeInitiativeCommand("add metric to Project X")).toBe(false);
    });
  });

  describe("should NOT trigger NLP for general questions about initiatives", () => {
    it("does NOT trigger for 'can you list all the initiatives?'", () => {
      expect(mightBeInitiativeCommand("can you list all the initiatives?")).toBe(false);
    });

    it("does NOT trigger for 'what are our initiatives?'", () => {
      expect(mightBeInitiativeCommand("what are our initiatives?")).toBe(false);
    });

    it("does NOT trigger for 'tell me about the initiatives'", () => {
      expect(mightBeInitiativeCommand("tell me about the initiatives")).toBe(false);
    });

    it("does NOT trigger for 'list all initiatives'", () => {
      expect(mightBeInitiativeCommand("list all initiatives")).toBe(false);
    });

    it("does NOT trigger for 'show me the initiatives'", () => {
      expect(mightBeInitiativeCommand("show me the initiatives")).toBe(false);
    });

    it("does NOT trigger for 'what initiatives are we working on?'", () => {
      expect(mightBeInitiativeCommand("what initiatives are we working on?")).toBe(false);
    });
  });
});
