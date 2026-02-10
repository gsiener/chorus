/**
 * Telemetry utilities for Chorus
 *
 * Provides helpers for adding structured attributes to OpenTelemetry spans.
 * Uses the active span from the OTel context.
 *
 * Follows OpenTelemetry Semantic Conventions:
 * - General: https://opentelemetry.io/docs/specs/semconv/
 * - GenAI v1.37.0+: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 * - HTTP: https://opentelemetry.io/docs/specs/semconv/http/
 * - Messaging: https://opentelemetry.io/docs/specs/semconv/messaging/
 *
 * Attribute namespacing:
 * - Standard OTel: gen_ai.*, http.*, error.*, etc.
 * - Slack-specific: slack.* (custom namespace for Slack API context)
 * - App-specific: chorus.* (custom namespace for Chorus features)
 *
 * GenAI semantic conventions:
 * - gen_ai.system: Provider identifier (e.g., "anthropic", "openai")
 * - gen_ai.operation.name: Operation type ("chat", "embeddings")
 * - gen_ai.request.model: Model name in request
 * - gen_ai.response.model: Actual model in response
 * - gen_ai.usage.input_tokens: Input token count
 * - gen_ai.usage.output_tokens: Output token count
 * - gen_ai.usage.estimated_cost_usd: Estimated cost in USD
 * - gen_ai.response.finish_reasons: Stop reasons array
 * - gen_ai.system_instructions: System prompt content
 * - gen_ai.input.messages: Serialized conversation messages
 * - gen_ai.output.content: Generated completion
 * - gen_ai.latency.*: Latency breakdown metrics
 *
 * Conversation quality signals:
 * - conversation.turn_count: Number of messages in thread
 * - conversation.context_length: Total characters of context
 * - conversation.was_truncated: Whether context was summarized
 *
 * RAG/Knowledge base metrics:
 * - knowledge_base.documents_count: Number of documents in KB
 * - knowledge_base.retrieval_latency_ms: Time to fetch KB
 * - knowledge_base.cache_hit: Whether KB was cached
 *
 * Error categorization:
 * - error.category: Type of error (rate_limit, auth, timeout, etc.)
 * - error.retryable: Whether the error is retryable
 *
 * Note: OTel spec recommends events for large payloads, but otel-cf-workers
 * doesn't export span events. We use span attributes as Honeycomb handles
 * high-cardinality string attributes well (wide events approach).
 */

import { trace, SpanStatusCode, Span, Attributes, AttributeValue } from "@opentelemetry/api";

/**
 * Standard GenAI system identifiers per OTel spec
 */
export const GEN_AI_SYSTEMS = {
  ANTHROPIC: "anthropic",
  OPENAI: "openai",
  COHERE: "cohere",
  VERTEX_AI: "vertex_ai",
  AWS_BEDROCK: "aws_bedrock",
  CLOUDFLARE: "cloudflare",
} as const;

export type GenAiSystem = (typeof GEN_AI_SYSTEMS)[keyof typeof GEN_AI_SYSTEMS];

/**
 * Get the current active span
 */
export function getActiveSpan(): Span | undefined {
  return trace.getActiveSpan();
}

/**
 * Safely set attributes on a span, handling cases where OTel is not fully initialized
 */
function safeSetAttributes(span: Span | undefined, attributes: Attributes): void {
  if (!span || typeof span.setAttributes !== "function") return;
  try {
    span.setAttributes(attributes);
  } catch {
    // Silently ignore OTel errors - telemetry should never break the app
  }
}

/**
 * Safely set a single attribute on a span
 */
function safeSetAttribute(span: Span | undefined, key: string, value: AttributeValue): void {
  if (!span || typeof span.setAttribute !== "function") return;
  try {
    span.setAttribute(key, value);
  } catch {
    // Silently ignore OTel errors - telemetry should never break the app
  }
}

/**
 * Record GenAI chat completion metrics on the active span
 * Follows OTel GenAI semantic conventions v1.29.0 for inference spans
 */
export function recordGenAiMetrics(metrics: {
  operationName: "chat" | "embeddings" | "text_completion";
  system?: GenAiSystem;
  requestModel: string;
  responseModel?: string;
  inputTokens: number;
  outputTokens: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  finishReasons?: string[];
  responseId?: string;
  streaming?: boolean;
  conversationId?: string;
  cacheHit?: boolean;
  // Anthropic prompt caching tokens (experimental convention)
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  // Tool/function calls (per GenAI events spec)
  toolCallsCount?: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  // Required attributes per OTel GenAI spec
  span.setAttributes({
    "gen_ai.operation.name": metrics.operationName,
    // gen_ai.system is the canonical identifier (replaces provider.name)
    "gen_ai.system": metrics.system ?? GEN_AI_SYSTEMS.ANTHROPIC,
    // gen_ai.provider.name for Honeycomb querying alongside gen_ai.system
    "gen_ai.provider.name": metrics.system ?? GEN_AI_SYSTEMS.ANTHROPIC,
    "gen_ai.request.model": metrics.requestModel,
  });

  // Token usage (recommended)
  span.setAttributes({
    "gen_ai.usage.input_tokens": metrics.inputTokens,
    "gen_ai.usage.output_tokens": metrics.outputTokens,
  });

  // Response model (may differ from request due to aliases)
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
  if (metrics.topK !== undefined) {
    span.setAttribute("gen_ai.request.top_k", metrics.topK);
  }
  if (metrics.stopSequences && metrics.stopSequences.length > 0) {
    span.setAttribute("gen_ai.request.stop_sequences", metrics.stopSequences);
  }

  // Response metadata (recommended)
  if (metrics.finishReasons && metrics.finishReasons.length > 0) {
    span.setAttribute("gen_ai.response.finish_reasons", metrics.finishReasons);
  }
  if (metrics.responseId) {
    span.setAttribute("gen_ai.response.id", metrics.responseId);
  }

  // Tool/function call tracking
  if (metrics.toolCallsCount !== undefined) {
    span.setAttribute("gen_ai.response.tool_calls_count", metrics.toolCallsCount);
  }

  // Conversation tracking (experimental)
  if (metrics.conversationId) {
    span.setAttribute("gen_ai.conversation.id", metrics.conversationId);
  }

  // Streaming indicator (experimental)
  if (metrics.streaming !== undefined) {
    span.setAttribute("gen_ai.request.streaming", metrics.streaming);
  }

  // Response-level cache hit (experimental)
  if (metrics.cacheHit !== undefined) {
    span.setAttribute("gen_ai.response.cache_hit", metrics.cacheHit);
  }

  // Anthropic prompt caching tokens (experimental convention)
  if (metrics.cacheCreationInputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cache_creation_input_tokens", metrics.cacheCreationInputTokens);
  }
  if (metrics.cacheReadInputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cache_read_input_tokens", metrics.cacheReadInputTokens);
  }

  // Record any pending input data (stored earlier via recordGenAiInput)
  if (_pendingGenAiInput) {
    const data = _pendingGenAiInput;
    _pendingGenAiInput = null; // Clear after use

    // Truncate large values to avoid otel-cf-workers limits
    const MAX_ATTR_LENGTH = 4096;
    const truncate = (s: string) => s.length > MAX_ATTR_LENGTH ? s.slice(0, MAX_ATTR_LENGTH) + "..." : s;

    // System instructions (OTel GenAI v1.37+ convention)
    span.setAttribute("gen_ai.system_instructions", truncate(data.systemPrompt));
    span.setAttribute("gen_ai.system_instructions.length", data.systemPrompt.length);

    // Serialize messages as JSON for queryability (Honeycomb wide events approach)
    const messagesJson = JSON.stringify(data.messages);
    span.setAttribute("gen_ai.input.messages", truncate(messagesJson));
    span.setAttribute("gen_ai.input.messages_count", data.messages.length);

    // Message counts for filtering
    const userCount = data.messages.filter((m) => m.role === "user").length;
    const assistantCount = data.messages.filter((m) => m.role === "assistant").length;
    span.setAttribute("gen_ai.input.user_message_count", userCount);
    span.setAttribute("gen_ai.input.assistant_message_count", assistantCount);
  }
}

/**
 * Record GenAI embeddings operation metrics
 * Follows OTel GenAI semantic conventions v1.29.0 for embeddings spans
 */
export function recordEmbeddingsMetrics(metrics: {
  model: string;
  system?: GenAiSystem;
  inputTokens?: number;
  dimensionCount?: number;
  inputCount?: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "gen_ai.operation.name": "embeddings",
    "gen_ai.system": metrics.system ?? GEN_AI_SYSTEMS.CLOUDFLARE,
    "gen_ai.request.model": metrics.model,
  });

  if (metrics.inputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", metrics.inputTokens);
  }
  if (metrics.dimensionCount !== undefined) {
    span.setAttribute("gen_ai.request.embedding_dimensions", metrics.dimensionCount);
  }
  if (metrics.inputCount !== undefined) {
    span.setAttribute("gen_ai.request.input_count", metrics.inputCount);
  }
}

/**
 * Record GenAI input (system prompt + messages) as span attributes
 * Call this BEFORE the API call so otel-cf-workers captures the attributes
 *
 * Uses OTel GenAI semantic conventions v1.37+:
 * - gen_ai.system_instructions for system prompt
 * - gen_ai.input.messages for serialized conversation
 */
export function recordGenAiInput(data: {
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): void {
  // Store for later recording after API call completes
  // This is needed because otel-cf-workers may not export attributes set early in the request
  _pendingGenAiInput = data;
}

// Pending input data to be recorded with metrics
let _pendingGenAiInput: {
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} | null = null;

/**
 * Record GenAI output (completion) as span attribute
 * Call this AFTER the API response but while span is still active
 *
 * Uses OTel GenAI semantic conventions v1.37+:
 * - gen_ai.output.content for the generated text
 */
export function recordGenAiOutput(completion: string): void {
  const span = getActiveSpan();
  if (span) {
    // Truncate to avoid otel-cf-workers limits
    const MAX_ATTR_LENGTH = 4096;
    const truncated = completion.length > MAX_ATTR_LENGTH
      ? completion.slice(0, MAX_ATTR_LENGTH) + "..."
      : completion;

    // Set on span for Honeycomb wide events queryability
    span.setAttribute("gen_ai.output.content", truncated);
    span.setAttribute("gen_ai.output.content.length", completion.length);
  }
}

/**
 * Combined function to record both input and output GenAI content
 * Useful for recording everything in one call after the API response
 */
export function recordGenAiMessages(data: {
  systemPrompt?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  completion?: string;
}): void {
  // Record input if provided (may duplicate if recordGenAiInput was called earlier)
  if (data.systemPrompt) {
    recordGenAiInput({
      systemPrompt: data.systemPrompt,
      messages: data.messages,
    });
  }

  // Record output completion
  if (data.completion) {
    recordGenAiOutput(data.completion);
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
 * Record rich request context for wide events (call at start of request handling)
 */
export function recordRequestContext(context: {
  // Slack message context
  userId: string;
  channel: string;
  messageLength: number;
  isThread: boolean;
  threadTs?: string;
  hasFiles: boolean;
  fileCount: number;
  // Event type
  eventType: "app_mention" | "reaction_added" | "scheduled";
}): void {
  const span = getActiveSpan();
  if (!span || typeof span.setAttributes !== "function") return;

  span.setAttributes({
    // User context
    "slack.user_id": context.userId,
    "slack.channel": context.channel,
    "slack.event_type": context.eventType,
    // Message context
    "slack.message.length": context.messageLength,
    "slack.message.has_files": context.hasFiles,
    "slack.message.file_count": context.fileCount,
    // Thread context
    "slack.is_thread": context.isThread,
  });

  if (context.threadTs && typeof span.setAttribute === "function") {
    span.setAttribute("slack.thread_ts", context.threadTs);
  }
}

/**
 * Record thread context after fetching thread messages
 */
export function recordThreadContext(context: {
  messageCount: number;
  userMessageCount: number;
  botMessageCount: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "slack.thread.message_count": context.messageCount,
    "slack.thread.user_message_count": context.userMessageCount,
    "slack.thread.bot_message_count": context.botMessageCount,
  });
}

/**
 * Record search results context
 */
export function recordSearchResults(context: {
  query: string;
  docResultsCount: number;
  initiativeResultsCount: number;
  topDocScore?: number;
  topInitiativeScore?: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "chorus.search.query_length": context.query.length,
    "chorus.search.doc_results_count": context.docResultsCount,
    "chorus.search.initiative_results_count": context.initiativeResultsCount,
    "chorus.search.total_results_count": context.docResultsCount + context.initiativeResultsCount,
    "chorus.search.has_results": context.docResultsCount + context.initiativeResultsCount > 0,
  });

  if (context.topDocScore !== undefined) {
    span.setAttribute("chorus.search.top_doc_score", context.topDocScore);
  }
  if (context.topInitiativeScore !== undefined) {
    span.setAttribute("chorus.search.top_initiative_score", context.topInitiativeScore);
  }
}

/**
 * Record Claude response context (enhanced version)
 */
export function recordClaudeResponse(context: {
  responseLength: number;
  cached: boolean;
  inputTokens: number;
  outputTokens: number;
  messagesCount: number;
  hasKnowledgeBase: boolean;
  stopReason?: string;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    // Response metrics
    "chorus.response.length": context.responseLength,
    "chorus.response.cached": context.cached,
    // Token metrics (OTel GenAI conventions)
    "gen_ai.usage.input_tokens": context.inputTokens,
    "gen_ai.usage.output_tokens": context.outputTokens,
    "gen_ai.usage.total_tokens": context.inputTokens + context.outputTokens,
    // Conversation context
    "gen_ai.request.messages_count": context.messagesCount,
    "gen_ai.request.has_knowledge_base": context.hasKnowledgeBase,
    "gen_ai.response.cache_hit": context.cached,
  });

  if (context.stopReason) {
    span.setAttribute("gen_ai.response.finish_reason", context.stopReason);
  }

  // Add span event for the completion
  span.addEvent("response_complete", {
    "chorus.response.length": context.responseLength,
    "gen_ai.usage.input_tokens": context.inputTokens,
    "gen_ai.usage.output_tokens": context.outputTokens,
    "gen_ai.response.cache_hit": context.cached,
  });
}

/**
 * Record file processing context
 */
export function recordFileProcessing(context: {
  fileName: string;
  fileType: string;
  fileSizeKb: number;
  extractedLength?: number;
  success: boolean;
  errorMessage?: string;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "chorus.file.name": context.fileName,
    "chorus.file.type": context.fileType,
    "chorus.file.size_kb": context.fileSizeKb,
    "chorus.file.success": context.success,
  });

  if (context.extractedLength !== undefined) {
    span.setAttribute("chorus.file.extracted_length", context.extractedLength);
  }
  if (context.errorMessage) {
    span.setAttribute("chorus.file.error", context.errorMessage);
  }
}

/**
 * Record rate limiting context
 */
export function recordRateLimit(context: {
  userId: string;
  action: string;
  wasLimited: boolean;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "chorus.rate_limit.action": context.action,
    "chorus.rate_limit.was_limited": context.wasLimited,
  });

  if (context.wasLimited) {
    span.addEvent("rate_limited", {
      "slack.user_id": context.userId,
      "chorus.rate_limit.action": context.action,
    });
  }
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

// ============================================================================
// Cost Tracking
// ============================================================================

/**
 * Claude model pricing (USD per 1M tokens) as of Jan 2025
 * https://www.anthropic.com/pricing
 */
const CLAUDE_PRICING: Record<string, { input: number; output: number }> = {
  // Claude 3.5 Sonnet
  "claude-3-5-sonnet-20240620": { input: 3.0, output: 15.0 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  // Claude 3.5 Haiku
  "claude-3-5-haiku-20241022": { input: 1.0, output: 5.0 },
  // Claude 3 Opus
  "claude-3-opus-20240229": { input: 15.0, output: 75.0 },
  // Claude Opus 4.5
  "claude-opus-4-5-20251101": { input: 15.0, output: 75.0 },
  // Default fallback (assume Opus pricing as safe upper bound)
  default: { input: 15.0, output: 75.0 },
};

/**
 * Calculate estimated cost in USD for a Claude API call
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = CLAUDE_PRICING[model] ?? CLAUDE_PRICING.default;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Record cost tracking attribute on the active span
 */
export function recordCost(estimatedCostUsd: number): void {
  const span = getActiveSpan();
  if (span) {
    span.setAttribute("gen_ai.usage.estimated_cost_usd", estimatedCostUsd);
  }
}

// ============================================================================
// Latency Tracking
// ============================================================================

/**
 * Record GenAI latency breakdown on the active span
 * @param latency.streaming - if true, TTFT is from the streaming path; if false, TTFT = total duration
 */
export function recordGenAiLatency(latency: {
  totalGenerationMs: number;
  timeToFirstTokenMs?: number;
  streaming?: boolean;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttribute("gen_ai.latency.total_generation_ms", latency.totalGenerationMs);

  // Seconds-unit attribute for Honeycomb HEATMAP/P99 queries
  const durationS = latency.totalGenerationMs / 1000;
  span.setAttribute("gen_ai.client.operation.duration_s", durationS);

  if (latency.timeToFirstTokenMs !== undefined) {
    span.setAttribute("gen_ai.latency.time_to_first_token_ms", latency.timeToFirstTokenMs);
    span.setAttribute("gen_ai.server.time_to_first_token_s", latency.timeToFirstTokenMs / 1000);
  } else if (latency.streaming === false) {
    // Non-streaming: TTFT ≈ total duration (server returns all at once)
    span.setAttribute("gen_ai.server.time_to_first_token_s", durationS);
  }
}

/**
 * Record Slack API latency on the active span
 */
export function recordSlackLatency(latency: {
  threadFetchMs?: number;
  messagePostMs?: number;
  messageUpdateMs?: number;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  if (latency.threadFetchMs !== undefined) {
    span.setAttribute("slack.latency.thread_fetch_ms", latency.threadFetchMs);
  }
  if (latency.messagePostMs !== undefined) {
    span.setAttribute("slack.latency.message_post_ms", latency.messagePostMs);
  }
  if (latency.messageUpdateMs !== undefined) {
    span.setAttribute("slack.latency.message_update_ms", latency.messageUpdateMs);
  }
}

// ============================================================================
// Conversation Quality Signals
// ============================================================================

/**
 * Record conversation quality signals on the active span
 */
export function recordConversationQuality(context: {
  turnCount: number;
  contextLength: number;
  wasTruncated: boolean;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "conversation.turn_count": context.turnCount,
    "conversation.context_length": context.contextLength,
    "conversation.was_truncated": context.wasTruncated,
  });
}

// ============================================================================
// RAG/Knowledge Base Metrics
// ============================================================================

/**
 * Record knowledge base retrieval metrics on the active span
 */
export function recordKnowledgeBaseMetrics(metrics: {
  documentsCount: number;
  totalCharacters?: number;
  retrievalLatencyMs: number;
  cacheHit: boolean;
}): void {
  const span = getActiveSpan();
  if (!span) return;

  span.setAttributes({
    "knowledge_base.documents_count": metrics.documentsCount,
    "knowledge_base.retrieval_latency_ms": metrics.retrievalLatencyMs,
    "knowledge_base.cache_hit": metrics.cacheHit,
  });

  if (metrics.totalCharacters !== undefined) {
    span.setAttribute("knowledge_base.total_characters", metrics.totalCharacters);
  }
}

// ============================================================================
// Error Categorization
// ============================================================================

/**
 * Error categories for classification
 */
export type ErrorCategory =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "model_error"
  | "invalid_request"
  | "network"
  | "internal"
  | "unknown";

/**
 * Categorize an error based on its message and type
 */
export function categorizeError(error: Error): { category: ErrorCategory; retryable: boolean } {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Rate limiting
  if (message.includes("rate") || message.includes("429") || message.includes("too many")) {
    return { category: "rate_limit", retryable: true };
  }

  // Authentication
  if (message.includes("auth") || message.includes("401") || message.includes("403") ||
      message.includes("unauthorized") || message.includes("forbidden")) {
    return { category: "auth", retryable: false };
  }

  // Timeout
  if (message.includes("timeout") || message.includes("timed out") || name.includes("timeout")) {
    return { category: "timeout", retryable: true };
  }

  // Model errors (Claude-specific)
  if (message.includes("overloaded") || message.includes("529") ||
      message.includes("model") || message.includes("500")) {
    return { category: "model_error", retryable: true };
  }

  // Invalid request
  if (message.includes("invalid") || message.includes("400") || message.includes("bad request")) {
    return { category: "invalid_request", retryable: false };
  }

  // Network errors
  if (message.includes("network") || message.includes("fetch") ||
      message.includes("connect") || name.includes("typeerror")) {
    return { category: "network", retryable: true };
  }

  return { category: "unknown", retryable: false };
}

/**
 * Record categorized error on the active span
 * Enhances the basic recordError with categorization
 */
export function recordCategorizedError(error: Error, context?: string): void {
  const span = getActiveSpan();
  if (!span) return;

  const { category, retryable } = categorizeError(error);

  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  });

  span.setAttributes({
    "error.type": error.name,
    "error.category": category,
    "error.retryable": retryable,
  });

  if (context) {
    span.setAttribute("error.context", context);
  }

  span.recordException(error);
}
