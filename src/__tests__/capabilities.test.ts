import { describe, it, expect } from "vitest";
import {
  CAPABILITIES,
  getCapabilityRegistry,
  getCapabilityForCommand,
  listCapabilities,
} from "../capabilities";

describe("Capabilities", () => {
  describe("CAPABILITIES", () => {
    it("has all expected capability types", () => {
      expect(CAPABILITIES.conversation).toBeDefined();
      expect(CAPABILITIES.initiatives).toBeDefined();
      expect(CAPABILITIES.documents).toBeDefined();
      expect(CAPABILITIES.search).toBeDefined();
      expect(CAPABILITIES.priorities).toBeDefined();
      expect(CAPABILITIES.checkins).toBeDefined();
      expect(CAPABILITIES.admin).toBeDefined();
    });

    it("each capability has name and description", () => {
      for (const [, capability] of Object.entries(CAPABILITIES)) {
        expect(capability.name).toBeDefined();
        expect(capability.name.length).toBeGreaterThan(0);
        expect(capability.description).toBeDefined();
        expect(capability.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("getCapabilityRegistry", () => {
    it("returns formatted string with all capabilities", () => {
      const registry = getCapabilityRegistry();

      expect(registry).toContain("Natural Conversation");
      expect(registry).toContain("Initiative Tracking");
      expect(registry).toContain("Document Management");
      expect(registry).toContain("Semantic Search");
    });

    it("includes descriptions", () => {
      const registry = getCapabilityRegistry();

      expect(registry).toContain("remember context");
      expect(registry).toContain("knowledge base");
    });
  });

  describe("getCapabilityForCommand", () => {
    it("finds capability for initiative commands", () => {
      const capability = getCapabilityForCommand("initiatives");
      expect(capability).not.toBeNull();
      expect(capability!.name).toBe("Initiative Tracking");
    });

    it("finds capability for doc commands", () => {
      const capability = getCapabilityForCommand("docs");
      expect(capability).not.toBeNull();
      expect(capability!.name).toBe("Document Management");
    });

    it("finds capability for search commands", () => {
      const capability = getCapabilityForCommand("search");
      expect(capability).not.toBeNull();
      expect(capability!.name).toBe("Semantic Search");
    });

    it("returns null for unknown commands", () => {
      const capability = getCapabilityForCommand("unknown-command");
      expect(capability).toBeNull();
    });

    it("is case insensitive", () => {
      const capability = getCapabilityForCommand("DOCS");
      expect(capability).not.toBeNull();
      expect(capability!.name).toBe("Document Management");
    });
  });

  describe("listCapabilities", () => {
    it("returns all capabilities as array", () => {
      const capabilities = listCapabilities();

      expect(Array.isArray(capabilities)).toBe(true);
      expect(capabilities.length).toBe(Object.keys(CAPABILITIES).length);
    });

    it("each item has required fields", () => {
      const capabilities = listCapabilities();

      for (const capability of capabilities) {
        expect(capability.name).toBeDefined();
        expect(capability.description).toBeDefined();
      }
    });
  });
});
