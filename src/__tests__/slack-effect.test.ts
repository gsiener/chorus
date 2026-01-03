import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Exit, Cause, Layer, Context } from "effect";

// These imports will fail initially - expected (RED phase)
import {
  SlackService,
  SlackServiceLive,
  SignatureVerificationError,
  SlackApiError,
  verifySignatureEffect,
  fetchThreadMessagesEffect,
  postMessageEffect,
  updateMessageEffect,
  addReactionEffect,
  postDirectMessageEffect,
} from "../slack-effect";

describe("slack-effect", () => {
  const signingSecret = "test-signing-secret";
  const botToken = "xoxb-test-token";

  async function createValidSignature(
    body: string,
    timestamp: string
  ): Promise<string> {
    const sigBaseString = `v0:${timestamp}:${body}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(sigBaseString)
    );
    return (
      "v0=" +
      Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
  }

  // Create a test layer with mock config
  const TestSlackLayer = Layer.succeed(SlackService, {
    botToken,
    signingSecret,
  });

  describe("verifySignatureEffect", () => {
    it("succeeds for valid signature", async () => {
      const body = '{"test": "data"}';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = await createValidSignature(body, timestamp);

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
      });

      const effect = verifySignatureEffect(request, body);
      const result = await Effect.runPromise(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(result).toBe(true);
    });

    it("fails with SignatureVerificationError when timestamp is missing", async () => {
      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-slack-signature": "v0=abc123",
        },
      });

      const effect = verifySignatureEffect(request, "{}");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(SignatureVerificationError);
          expect((error.value as SignatureVerificationError).reason).toBe(
            "missing_headers"
          );
        }
      }
    });

    it("fails with SignatureVerificationError when timestamp is too old", async () => {
      const body = '{"test": "data"}';
      const oldTimestamp = (Math.floor(Date.now() / 1000) - 600).toString();
      const signature = await createValidSignature(body, oldTimestamp);

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": oldTimestamp,
          "x-slack-signature": signature,
        },
      });

      const effect = verifySignatureEffect(request, body);
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(SignatureVerificationError);
          expect((error.value as SignatureVerificationError).reason).toBe(
            "timestamp_expired"
          );
        }
      }
    });

    it("fails with SignatureVerificationError for invalid signature", async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": "v0=invalid_signature",
        },
      });

      const effect = verifySignatureEffect(request, "{}");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(SignatureVerificationError);
          expect((error.value as SignatureVerificationError).reason).toBe(
            "signature_mismatch"
          );
        }
      }
    });
  });

  describe("fetchThreadMessagesEffect", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns messages on success", async () => {
      const mockMessages = [
        { user: "U123", text: "Hello", ts: "1234.5678" },
        { user: "U456", text: "Hi there", ts: "1234.5679", bot_id: "B123" },
      ];

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, messages: mockMessages }))
      );

      const effect = fetchThreadMessagesEffect("C123", "1234.5678");
      const result = await Effect.runPromise(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(result).toEqual(mockMessages);
    });

    it("fails with SlackApiError on API error", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
      );

      const effect = fetchThreadMessagesEffect("C123", "1234.5678");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(SlackApiError);
          expect((error.value as SlackApiError).code).toBe("channel_not_found");
        }
      }
    });
  });

  describe("postMessageEffect", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns message ts on success", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, ts: "1234.5678" }))
      );

      const effect = postMessageEffect("C123", "Hello world", "1234.0000");
      const result = await Effect.runPromise(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(result).toBe("1234.5678");
    });

    it("fails with SlackApiError on API error", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
      );

      const effect = postMessageEffect("C123", "Hello", undefined);
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(SlackApiError);
        }
      }
    });
  });

  describe("updateMessageEffect", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns true on success", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      const effect = updateMessageEffect("C123", "1700000001.000000", "Updated");
      const result = await Effect.runPromise(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(result).toBe(true);
    });

    it("fails with SlackApiError on API error", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "message_not_found" }))
      );

      const effect = updateMessageEffect("C123", "1700000001.000000", "Updated");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  describe("addReactionEffect", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns true on success", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      const effect = addReactionEffect("C123", "1700000001.000000", "thumbsup");
      const result = await Effect.runPromise(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(result).toBe(true);
    });

    it("returns true when already reacted", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "already_reacted" }))
      );

      const effect = addReactionEffect("C123", "1700000001.000000", "thumbsup");
      const result = await Effect.runPromise(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(result).toBe(true);
    });

    it("fails with SlackApiError on other errors", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
      );

      const effect = addReactionEffect("C123", "1700000001.000000", "thumbsup");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  describe("postDirectMessageEffect", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("opens DM and posts message", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, channel: { id: "D123" } }))
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, ts: "1700000001.000000" }))
        );

      const effect = postDirectMessageEffect("U456", "Hello via DM!");
      const result = await Effect.runPromise(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(result).toBe("1700000001.000000");
    });

    it("fails with SlackApiError when DM cannot be opened", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "user_not_found" }))
      );

      const effect = postDirectMessageEffect("U456", "Hello!");
      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestSlackLayer)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(SlackApiError);
          expect((error.value as SlackApiError).code).toBe("user_not_found");
        }
      }
    });
  });

  describe("typed errors", () => {
    it("SignatureVerificationError has reason", () => {
      const error = new SignatureVerificationError("timestamp_expired");
      expect(error._tag).toBe("SignatureVerificationError");
      expect(error.reason).toBe("timestamp_expired");
    });

    it("SlackApiError has code and method", () => {
      const error = new SlackApiError("channel_not_found", "postMessage");
      expect(error._tag).toBe("SlackApiError");
      expect(error.code).toBe("channel_not_found");
      expect(error.method).toBe("postMessage");
    });
  });
});
