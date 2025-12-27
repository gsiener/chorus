export interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ANTHROPIC_API_KEY: string;
  HONEYCOMB_API_KEY: string;
  LINEAR_API_KEY?: string;
  DOCS_API_KEY?: string;
  DOCS_KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
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
  };
}

// Initiative tracking types

export type InitiativeStatusValue = "proposed" | "active" | "paused" | "completed" | "cancelled";

export interface InitiativeStatus {
  value: InitiativeStatusValue;
  updatedAt: string;
  updatedBy: string;
}

export interface ExpectedMetric {
  type: "gtm" | "product";
  name: string;       // e.g., "DAU", "Revenue", "Retention"
  target: string;     // e.g., "Increase by 10%", "$500K ARR"
}

export interface Initiative {
  id: string;
  name: string;
  description: string;
  owner: string;              // Slack user ID
  status: InitiativeStatus;
  expectedMetrics: ExpectedMetric[];
  prdLink?: string;           // Google Docs URL
  linearProjectId?: string;   // For Linear sync
  strategyDocRef?: string;    // Reference to a doc in knowledge base
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  lastDiscussedAt?: string;   // For nudge detection
  tags?: string[];            // Freeform categorization
}

export interface InitiativeMetadata {
  id: string;
  name: string;
  owner: string;
  status: InitiativeStatusValue;
  hasMetrics: boolean;
  hasPrd: boolean;
  updatedAt: string;
}

export interface InitiativeIndex {
  initiatives: InitiativeMetadata[];
  lastSyncedWithLinear?: string;
}
