/**
 * Telemetry utilities for Chorus
 *
 * Provides helpers for adding structured attributes to OpenTelemetry spans.
 * Uses the active span from the OTel context.
 *
 * Follows OTel GenAI Semantic Conventions:
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import { trace, SpanStatusCode, Span } from "@opentelemetry/api";

/**
 * Get the current active span
 */
export function getActiveSpan(): Span | undefined {
  return trace.getActiveSpan();
}

/**
 * Record GenAI chat completion metrics on the active span
 * Follows OTel GenAI semantic conventions for inference spans
 */
export function recordGenAiMetrics(metrics: {
  operationName: "chat" | "embeddings";
  requestModel: string;
  responseModel?: string;
  inputTokens: number;
  outputTokens: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  finishReasons?: string[];
  responseId?: string;
  streaming?: boolean;
  conversationId?: string;
  cacheHit?: boolean;
  // Anthropic prompt caching tokens
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  // Required attributes
  span.setAttributes({
    "gen_ai.operation.name": metrics.operationName,
    "gen_ai.provider.name": "anthropic",
    "gen_ai.request.model": metrics.requestModel,
  });

  // Token usage (recommended)
  span.setAttributes({
    "gen_ai.usage.input_tokens": metrics.inputTokens,
    "gen_ai.usage.output_tokens": metrics.outputTokens,
  });

  // Response model (may differ from request)
  if (metrics.responseModel) {
    span.setAttribute("gen_ai.response.model", metrics.responseModel);
  }

  // Request parameters (recommended)
  if (metrics.maxTokens !== undefined) {
    span.setAttribute("gen_ai.request.max_tokens", metrics.maxTokens);
  }
  if (metrics.temperature !== undefined) {
    span.setAttribute("gen_ai.request.temperature", metrics.temperature);
  }
  if (metrics.topP !== undefined) {
    span.setAttribute("gen_ai.request.top_p", metrics.topP);
  }

  // Response metadata (recommended)
  if (metrics.finishReasons) {
    span.setAttribute("gen_ai.response.finish_reasons", metrics.finishReasons);
  }
  if (metrics.responseId) {
    span.setAttribute("gen_ai.response.id", metrics.responseId);
  }

  // Conversation tracking
  if (metrics.conversationId) {
    span.setAttribute("gen_ai.conversation.id", metrics.conversationId);
  }

  // Custom: streaming indicator (not in spec but useful)
  if (metrics.streaming !== undefined) {
    span.setAttribute("gen_ai.request.streaming", metrics.streaming);
  }

  // Custom: cache hit indicator (response-level caching)
  if (metrics.cacheHit !== undefined) {
    span.setAttribute("gen_ai.response.cache_hit", metrics.cacheHit);
  }

  // Anthropic prompt caching tokens (per OTel GenAI conventions discussion)
  if (metrics.cacheCreationInputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cache_creation_input_tokens", metrics.cacheCreationInputTokens);
  }
  if (metrics.cacheReadInputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cache_read_input_tokens", metrics.cacheReadInputTokens);
  }
}

/**
 * Record GenAI embeddings operation metrics
 * Follows OTel GenAI semantic conventions for embeddings spans
 */
export function recordEmbeddingsMetrics(metrics: {
  model: string;
  inputTokens?: number;
  dimensionCount?: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "gen_ai.operation.name": "embeddings",
    "gen_ai.provider.name": "cloudflare",
    "gen_ai.request.model": metrics.model,
  });

  if (metrics.inputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", metrics.inputTokens);
  }
  if (metrics.dimensionCount !== undefined) {
    span.setAttribute("gen_ai.embeddings.dimension.count", metrics.dimensionCount);
  }
}

/**
 * Backward-compatible alias for recordGenAiMetrics
 * @deprecated Use recordGenAiMetrics instead
 */
export function recordClaudeMetrics(metrics: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  streaming?: boolean;
}): void {
  recordGenAiMetrics({
    operationName: "chat",
    requestModel: metrics.model,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    streaming: metrics.streaming,
  });
}

/**
 * Record Slack API call on the active span
 */
export function recordSlackApiCall(endpoint: string, success: boolean): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "slack.api.endpoint": endpoint,
    "slack.api.success": success,
  });
}

/**
 * Record document operation on the active span
 * Uses gen_ai.data_source.* for RAG-related operations
 */
export function recordDocOperation(operation: {
  type: "add" | "remove" | "search" | "backfill";
  title?: string;
  charCount?: number;
  success: boolean;
  chunksIndexed?: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "gen_ai.data_source.operation": operation.type,
    "gen_ai.data_source.success": operation.success,
  });

  if (operation.title) {
    span.setAttribute("gen_ai.data_source.id", operation.title);
  }
  if (operation.charCount !== undefined) {
    span.setAttribute("gen_ai.data_source.char_count", operation.charCount);
  }
  if (operation.chunksIndexed !== undefined) {
    span.setAttribute("gen_ai.data_source.chunks_indexed", operation.chunksIndexed);
  }
}

/**
 * Record vector search operation on the active span
 */
export function recordVectorSearch(metrics: {
  query: string;
  resultsCount: number;
  topScore?: number;
  latencyMs?: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "gen_ai.data_source.operation": "search",
    "gen_ai.data_source.query_length": metrics.query.length,
    "gen_ai.data_source.results_count": metrics.resultsCount,
  });

  if (metrics.topScore !== undefined) {
    span.setAttribute("gen_ai.data_source.top_score", metrics.topScore);
  }
  if (metrics.latencyMs !== undefined) {
    span.setAttribute("gen_ai.data_source.latency_ms", metrics.latencyMs);
  }
}

/**
 * Record initiative operation on the active span
 */
export function recordInitiativeOperation(operation: {
  type: "add" | "update" | "remove" | "search" | "sync";
  name?: string;
  success: boolean;
  count?: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "chorus.initiative.operation": operation.type,
    "chorus.initiative.success": operation.success,
  });

  if (operation.name) {
    span.setAttribute("chorus.initiative.name", operation.name);
  }
  if (operation.count !== undefined) {
    span.setAttribute("chorus.initiative.count", operation.count);
  }
}

/**
 * Record error on the active span
 * Uses OTel standard error.type attribute
 */
export function recordError(error: Error, context?: string): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  });

  // error.type is standard OTel attribute
  span.setAttribute("error.type", error.name);

  if (context) {
    span.setAttribute("error.context", context);
  }

  span.recordException(error);
}

/**
 * Record command type on the active span
 */
export function recordCommand(command: string): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttribute("chorus.command", command);
}

/**
 * Record user feedback (thumbs up/down) on bot responses
 * Uses OTel span attributes and events (preferred for tracing)
 *
 * @param feedback - "positive" for thumbsup, "negative" for thumbsdown
 * @param attributes - Additional context about the feedback
 */
export function recordFeedback(
  feedback: "positive" | "negative",
  attributes: {
    reaction: string;
    userId: string;
    channel: string;
    messageTs: string;
  }
): void {
  const span = getActiveSpan();

  // Set span attributes for filtering/grouping in traces (primary method)
  span?.setAttributes({
    "chorus.feedback": feedback,
    "chorus.feedback.message_ts": attributes.messageTs,
    "slack.event_type": "reaction_added",
    "slack.reaction": attributes.reaction,
    "slack.user_id": attributes.userId,
    "slack.channel": attributes.channel,
  });

  // Add span event for the feedback occurrence (OTel best practice)
  span?.addEvent("feedback_received", {
    "chorus.feedback": feedback,
    "chorus.feedback.message_ts": attributes.messageTs,
    "slack.reaction": attributes.reaction,
    "slack.user_id": attributes.userId,
    "slack.channel": attributes.channel,
  });

  // Fallback structured log for Cloudflare Workers observability
  // (in case span attributes aren't exported by workers-observability)
  console.info("feedback", {
    "chorus.feedback": feedback,
    "chorus.feedback.message_ts": attributes.messageTs,
    "slack.reaction": attributes.reaction,
    "slack.user_id": attributes.userId,
    "slack.channel": attributes.channel,
  });
}

/**
 * Emit a structured log event with attributes
 * Uses console methods that Cloudflare Workers observability can parse
 *
 * @param eventName - Name of the event (appears in 'body' or 'name')
 * @param attributes - Key-value pairs to log as separate fields
 * @param level - Log level (info, warn, error)
 */
export function emitLogEvent(
  eventName: string,
  attributes: Record<string, string | number | boolean>,
  level: "info" | "warn" | "error" = "info"
): void {
  const logFn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;

  // Cloudflare Workers observability parses object arguments as attributes
  logFn(eventName, attributes);
}
