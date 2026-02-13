export interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ANTHROPIC_API_KEY: string;
  HONEYCOMB_API_KEY: string;
  LINEAR_API_KEY?: string;
  DOCS_API_KEY?: string;
  AMPLITUDE_API_KEY?: string;
  AMPLITUDE_API_SECRET?: string;
  TEST_CHECKIN_USER?: string; // When set, only send check-ins to this user (for testing)
  RD_PRIORITIES_INITIATIVE_ID?: string; // Linear parent initiative ID for R&D Priorities
  COMPANY_NAME?: string; // Company name used in system prompt context (default: "the company")
  DOCS_KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
}

// Shared pagination options for list operations
export interface PaginationOptions {
  page?: number;
  pageSize?: number;
}

export interface SlackUrlVerification {
  type: "url_verification";
  challenge: string;
}

export interface SlackEventCallback {
  type: "event_callback";
  event: SlackEvent;
  event_id: string;
  event_time: number;
}

export type SlackPayload = SlackUrlVerification | SlackEventCallback;

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size?: number;
  url_private: string;
  url_private_download?: string;
}

export interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
}

export interface SlackReactionAddedEvent {
  type: "reaction_added";
  user: string;
  reaction: string;
  item: {
    type: "message";
    channel: string;
    ts: string;
  };
  item_user: string;
  event_ts: string;
}

export type SlackEvent = SlackAppMentionEvent | SlackReactionAddedEvent;

export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  bot_id?: string;
}

export interface SlackThreadResponse {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
}

export interface SlackPostResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClaudeResponse {
  id: string;
  model: string;
  content: Array<{ type: "text"; text: string }>;
  stop_reason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// Feedback log types

export interface FeedbackRecord {
  prompt: string;
  response: string;
  user: string;
  channel: string;
  ts: string;               // Bot response message timestamp
  timestamp: string;         // ISO 8601
  inputTokens: number;
  outputTokens: number;
  feedback?: {
    type: "positive" | "negative";
    reactor: string;
    reactedAt: string;
  };
}

export interface FeedbackMetadata {
  prompt: string;            // Truncated to 100 chars for KV list view
  user: string;
  feedback?: "positive" | "negative";
  timestamp: string;
}

// Thread context types for conversation memory

export interface ThreadContext {
  threadTs: string;            // Thread identifier
  channel: string;             // Channel ID
  summary?: string;            // Summary of earlier conversation
  keyTopics: string[];         // Key topics/entities mentioned
  messageCount: number;        // Total messages in thread
  lastUpdatedAt: string;       // When context was last updated
}
