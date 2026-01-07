import { Command } from "./types";
import {
  addReaction,
  convertThreadToMessages,
  fetchThreadMessages,
  postMessage,
  updateMessage,
} from "../slack";
import {
  recordClaudeResponse,
  recordSlackLatency,
  recordThreadContext,
} from "../telemetry";
import { generateResponse, ThreadInfo } from "../claude";

export const claudeCommand: Command = {
  name: "claude",
  match: (event) => {
    // This is the fallback command, so it should always match.
    return true;
  },
  execute: async (event, botUserId, env) => {
    const { user, channel, thread_ts, ts, text } = event;
    const threadTs = thread_ts ?? ts;

    let messages;
    let threadMessageCount = 1;
    let threadFetchMs: number | undefined;

    if (thread_ts) {
      const threadFetchStart = Date.now();
      const threadMessages = await fetchThreadMessages(channel, thread_ts, env);
      threadFetchMs = Date.now() - threadFetchStart;
      recordSlackLatency({ threadFetchMs });

      messages = convertThreadToMessages(threadMessages, botUserId);
      threadMessageCount = threadMessages.length;

      const userMessages = threadMessages.filter((m) => m.user !== botUserId).length;
      const botMessages = threadMessages.filter((m) => m.user === botUserId).length;
      recordThreadContext({
        messageCount: threadMessages.length,
        userMessageCount: userMessages,
        botMessageCount: botMessages,
      });
    } else {
      messages = [
        {
          role: "user" as const,
          content: text,
        },
      ];
    }

    const postStart = Date.now();
    const thinkingTs = await postMessage(
      channel,
      "✨ Thinking...",
      threadTs,
      env
    );
    const messagePostMs = Date.now() - postStart;
    recordSlackLatency({ messagePostMs });

    if (!thinkingTs) {
      throw new Error("Failed to post thinking message");
    }

    const threadInfo: ThreadInfo | undefined = threadTs
      ? { channel, threadTs }
      : undefined;
    const result = await generateResponse(messages, env, threadInfo);

    const updateStart = Date.now();
    await updateMessage(channel, thinkingTs, result.text, env);
    const messageUpdateMs = Date.now() - updateStart;
    recordSlackLatency({ messageUpdateMs });

    await addReaction(channel, thinkingTs, "thumbsup", env);
    await addReaction(channel, thinkingTs, "thumbsdown", env);

    recordClaudeResponse({
      responseLength: result.text.length,
      cached: result.cached,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      messagesCount: messages.length,
      hasKnowledgeBase: true, 
    });
  },
};
