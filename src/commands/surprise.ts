import { Command } from "./types";
import { postMessage } from "../slack";
import { recordCommand } from "../telemetry";
import { getRandomDocument } from "../docs";

export const surpriseCommand: Command = {
  name: "surprise",
  match: (event) => {
    return /^surprise\s*me$/i.test(event.text);
  },
  execute: async (event, botUserId, env) => {
    recordCommand("surprise");
    const threadTs = event.thread_ts ?? event.ts;
    const result = await getRandomDocument(env);
    await postMessage(event.channel, result.message, threadTs, env);
  },
};
