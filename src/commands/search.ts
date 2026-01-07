import { Command } from "./types";
import { postMessage } from "../slack";
import { recordCommand, recordRateLimit, recordSearchResults } from "../telemetry";
import { parseSearchCommand } from "../parseCommands";
import { searchDocuments, formatSearchResultsForUser } from "../embeddings";
import { searchInitiatives } from "../initiatives";
import { isRateLimited } from "../rate-limiting";

export const searchCommand: Command = {
  name: "search",
  match: (event, botUserId) => {
    return !!parseSearchCommand(event.text, botUserId);
  },
  execute: async (event, botUserId, env) => {
    const { user, channel, thread_ts, ts } = event;
    const threadTs = thread_ts ?? ts;
    recordCommand("search");

    const searchLimited = await isRateLimited(user, "search", env);
    recordRateLimit({ userId: user, action: "search", wasLimited: searchLimited });
    if (searchLimited) {
      await postMessage(
        channel,
        "You're searching too quickly. Please wait a moment before trying again.",
        threadTs,
        env
      );
      return;
    }

    const command = parseSearchCommand(event.text, botUserId);
    const query = command!.query;

    const [docResults, initiativeResults] = await Promise.all([
      searchDocuments(query, env, 5),
      searchInitiatives(env, query, 5),
    ]);

    recordSearchResults({
      query,
      docResultsCount: docResults.length,
      initiativeResultsCount: initiativeResults.length,
      topDocScore: docResults[0]?.score,
      topInitiativeScore: initiativeResults[0]?.score,
    });

    const sections: string[] = [];

    if (docResults.length > 0) {
      sections.push(formatSearchResultsForUser(docResults));
    }

    if (initiativeResults.length > 0) {
      const initLines: string[] = [`*Initiative Results* (${initiativeResults.length} found)`];
      for (const result of initiativeResults) {
        const statusEmoji =
          result.initiative.status === "active"
            ? "🟢"
            : result.initiative.status === "proposed"
            ? "🟡"
            : result.initiative.status === "completed"
            ? "✅"
            : result.initiative.status === "paused"
            ? "⏸️"
            : "❌";
        initLines.push(`
${statusEmoji} *${result.initiative.name}* (${result.initiative.status})`);
        initLines.push(`  Owner: <@${result.initiative.owner}>`);
        if (result.snippet !== result.initiative.name) {
          initLines.push(`  _${result.snippet}_`);
        }
      }
      sections.push(initLines.join("\n"));
    }

    if (sections.length === 0) {
      await postMessage(channel, `No results found for "${query}".`, threadTs, env);
    } else {
      await postMessage(channel, sections.join("\n\n---\n\n"), threadTs, env);
    }
  },
};
