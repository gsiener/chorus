import { Command } from "./types";
import { postMessage } from "../slack";
import { recordCommand, recordRateLimit } from "../telemetry";
import { parseDocCommand } from "../parseCommands";
import { isRateLimited } from "../rate-limiting";
import { addDocument, backfillDocuments, listDocuments, removeDocument } from "../docs";

export const docCommand: Command = {
  name: "doc",
  match: (event, botUserId) => {
    return !!parseDocCommand(event.text, botUserId);
  },
  execute: async (event, botUserId, env) => {
    const { user, channel, thread_ts, ts } = event;
    const threadTs = thread_ts ?? ts;

    const docCommand = parseDocCommand(event.text, botUserId);
    if (!docCommand) {
        return; // Should not happen due to match function
    }

    recordCommand(`docs:${docCommand.type}`);

    if (docCommand.type !== "list") {
      const docLimited = await isRateLimited(user, "doc", env);
      recordRateLimit({ userId: user, action: "doc", wasLimited: docLimited });
      if (docLimited) {
        await postMessage(
          channel,
          "You're adding documents too quickly. Please wait a minute before trying again.",
          threadTs,
          env
        );
        return;
      }
    }

    let response: string;

    if (docCommand.type === "list") {
      const pagination = docCommand.page ? { page: docCommand.page } : undefined;
      response = await listDocuments(env, pagination);
    } else if (docCommand.type === "add") {
      const result = await addDocument(env, docCommand.title, docCommand.content, user);
      response = result.message;
    } else if (docCommand.type === "backfill") {
      await postMessage(channel, "Starting backfill of documents for semantic search...", threadTs, env);
      const result = await backfillDocuments(env);
      response = result.message;
    } else { // remove
      const result = await removeDocument(env, docCommand.title);
      response = result.message;
    }

    await postMessage(channel, response, threadTs, env);
  },
};
