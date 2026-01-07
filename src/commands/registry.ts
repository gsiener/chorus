import { Command } from "./types";
import { SlackAppMentionEvent } from "../types";
import { helpCommand } from "./help";

// Import commands here
// e.g. import { helpCommand } from "./help";

import { claudeCommand } from "./claude";
import { nlpCommand } from "./nlp";
import { initiativeCommand } from "./initiative";
import { docCommand } from "./doc";
import { fileCommand } from "./file";
import { searchCommand } from "./search";
import { surpriseCommand } from "./surprise";

const commands: Command[] = [
  helpCommand,
  surpriseCommand,
  searchCommand,
  fileCommand,
  docCommand,
  initiativeCommand,
  nlpCommand,
  claudeCommand,
  // Add commands here
  // e.g. helpCommand,
];

export function getCommand(
  event: SlackAppMentionEvent,
  botUserId: string
): Command | undefined {
  const cleanedText = event.text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  // A new event is created with the cleaned text to avoid cleaning it in every command
  const newEvent = { ...event, text: cleanedText };
  return commands.find((command) => command.match(newEvent, botUserId));
}
