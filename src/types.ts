export interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ANTHROPIC_API_KEY: string;
  HONEYCOMB_API_KEY: string;
  DOCS_KV: KVNamespace;
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
  url_private: string;
  url_private_download?: string;
}

export interface SlackEvent {
  type: string;
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
}

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
  content: Array<{ type: "text"; text: string }>;
}
