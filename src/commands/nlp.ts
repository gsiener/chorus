import { Command } from "./types";
import { postMessage } from "../slack";
import { recordCommand } from "../telemetry";
import { mightBeInitiativeCommand, processNaturalLanguageCommand } from "../initiative-nlp";

export const nlpCommand: Command = {
  name: "nlp",
  match: (event) => {
    return mightBeInitiativeCommand(event.text);
  },
  execute: async (event, botUserId, env) => {
    const { user, channel, thread_ts, ts } = event;
    const threadTs = thread_ts ?? ts;

    recordCommand("nlp:initiative");
    const nlpResult = await processNaturalLanguageCommand(event.text, user, env);
    if (nlpResult) {
      await postMessage(channel, nlpResult, threadTs, env);
      return;
    }
  },
};
