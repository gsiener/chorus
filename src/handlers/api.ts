import { Context } from "hono";
import type { Env } from "../types";
import { sendWeeklyCheckins } from "../checkins";
import { generateResponse } from "../claude";
import { addDocument, removeDocument, listDocuments } from "../docs";

/**
 * Verify API key from Authorization header
 */
function verifyApiKey(c: Context<{ Bindings: Env }>): boolean {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice(7);
  return token === c.env.DOCS_API_KEY;
}

/**
 * Handle /api/test-checkin - trigger a test check-in DM
 */
export async function handleTestCheckin(c: Context<{ Bindings: Env }>): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (c.req.method !== "POST") {
    return c.json({ error: "Method not allowed" }, 405);
  }

  console.log("Manual test check-in triggered via API");
  const result = await sendWeeklyCheckins(c.env);

  return c.json(result, result.success ? 200 : 500);
}

/**
 * Handle /api/test-telemetry - trigger a Claude call to test telemetry
 */
export async function handleTestTelemetry(c: Context<{ Bindings: Env }>): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (c.req.method !== "POST") {
    return c.json({ error: "Method not allowed" }, 405);
  }

  console.log("Test telemetry triggered via API");

  // Make a simple Claude API call to test telemetry
  const messages = [{ role: "user" as const, content: "Say hello in exactly 3 words." }];
  const result = await generateResponse(messages, c.env);

  return c.json({
    success: true,
    response: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cached: result.cached,
  }, 200);
}

/**
 * Handle /api/docs requests for console-based document management
 */
export async function handleDocsApi(c: Context<{ Bindings: Env }>): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const method = c.req.method;

  // GET /api/docs - list documents
  if (method === "GET") {
    const list = await listDocuments(c.env);
    return c.json({ documents: list });
  }

  // POST /api/docs - add document
  if (method === "POST") {
    let body: { title?: string; content?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.title || !body.content) {
      return c.json({ error: "Missing required fields: title, content" }, 400);
    }

    const result = await addDocument(c.env, body.title, body.content, "api");
    return c.json(result, result.success ? 200 : 400);
  }

  // DELETE /api/docs - remove document
  if (method === "DELETE") {
    let body: { title?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.title) {
      return c.json({ error: "Missing required field: title" }, 400);
    }

    const result = await removeDocument(c.env, body.title);
    return c.json(result, result.success ? 200 : 404);
  }

  return c.json({ error: "Method not allowed" }, 405);
}
