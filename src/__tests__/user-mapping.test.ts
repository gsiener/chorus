import { describe, it, expect } from "vitest";
import {
  findUserByEmail,
  findUserByLinearId,
  User,
  USERS,
} from "../user-mapping";

describe("user-mapping", () => {
  describe("findUserByEmail", () => {
    it("returns user when email exists", () => {
      const user = findUserByEmail("test@honeycomb.io");
      expect(user).toBeDefined();
      expect(user?.email).toBe("test@honeycomb.io");
      expect(user?.name).toBe("Test User");
      expect(user?.linearId).toBe("test-linear-id");
      expect(user?.slackId).toBe("U_TEST_USER");
    });

    it("returns undefined when email not found", () => {
      const user = findUserByEmail("nonexistent@example.com");
      expect(user).toBeUndefined();
    });

    it("is case-sensitive", () => {
      const user = findUserByEmail("TEST@honeycomb.io");
      expect(user).toBeUndefined();
    });
  });

  describe("findUserByLinearId", () => {
    it("returns user when linearId exists", () => {
      const user = findUserByLinearId("test-linear-id");
      expect(user).toBeDefined();
      expect(user?.email).toBe("test@honeycomb.io");
      expect(user?.name).toBe("Test User");
      expect(user?.linearId).toBe("test-linear-id");
      expect(user?.slackId).toBe("U_TEST_USER");
    });

    it("returns undefined when linearId not found", () => {
      const user = findUserByLinearId("nonexistent-id");
      expect(user).toBeUndefined();
    });
  });
});
