import { Env, SlackAppMentionEvent } from "../types";

export interface Command {
  // The name of the command, used for logging and identification.
  name: string;

  // A function to determine if this command should be executed based on the event text.
  match: (event: SlackAppMentionEvent, botUserId: string) => boolean;

  // The function to execute if the command matches.
  execute: (
    event: SlackAppMentionEvent,
    botUserId: string,
    env: Env
  ) => Promise<void>;
}
