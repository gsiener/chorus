import { Command } from "./types";
import { postMessage } from "../slack";
import { recordCommand } from "../telemetry";
import { HELP_TEXT } from "../constants";

export const helpCommand: Command = {
  name: "help",
  match: (event) => {
    return /^help$/i.test(event.text);
  },
  execute: async (event, botUserId, env) => {
    recordCommand("help");
    const threadTs = event.thread_ts ?? event.ts;
    await postMessage(event.channel, HELP_TEXT, threadTs, env);
  },
};
