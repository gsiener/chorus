import { Command } from "./types";
import { postMessage } from "../slack";
import { recordCommand } from "../telemetry";
import { parseInitiativeCommand, VALID_STATUSES } from "../parseCommands";
import {
  addInitiative,
  getInitiative,
  removeInitiative,
  updateInitiativeStatus,
  updateInitiativePrd,
  updateInitiativeName,
  updateInitiativeDescription,
  updateInitiativeOwner,
  addInitiativeMetric,
  listInitiatives,
  formatInitiative,
  formatInitiativeList,
} from "../initiatives";
import { syncLinearProjects } from "../linear";
import { InitiativeStatusValue } from "../types";

export const initiativeCommand: Command = {
  name: "initiative",
  match: (event, botUserId) => {
    return !!parseInitiativeCommand(event.text, botUserId);
  },
  execute: async (event, botUserId, env) => {
    const { user, channel, thread_ts, ts } = event;
    const threadTs = thread_ts ?? ts;

    const initCommand = parseInitiativeCommand(event.text, botUserId);
    if (!initCommand) {
        return; // Should not happen due to match function
    }

    recordCommand(`initiative:${initCommand.type}`);
    let response: string;

    switch (initCommand.type) {
      case "list": {
        const filters = initCommand.filters;
        if (filters?.owner === "__CURRENT_USER__") {
          filters.owner = user;
        }
        const pagination = initCommand.page ? { page: initCommand.page } : undefined;
        const initiatives = await listInitiatives(env, filters, pagination);
        response = formatInitiativeList(initiatives);
        break;
      }
      case "add": {
        const result = await addInitiative(
          env,
          initCommand.name,
          initCommand.description,
          initCommand.owner,
          user
        );
        response = result.message;
        break;
      }
      case "show": {
        const initiative = await getInitiative(env, initCommand.name);
        response = initiative
          ? formatInitiative(initiative)
          : `Initiative "${initCommand.name}" not found.`;
        break;
      }
      case "update-status": {
        const result = await updateInitiativeStatus(
          env,
          initCommand.name,
          initCommand.status,
          user
        );
        response = result.message;
        break;
      }
      case "update-prd": {
        const result = await updateInitiativePrd(
          env,
          initCommand.name,
          initCommand.prdLink,
          user
        );
        response = result.message;
        break;
      }
      case "update-name": {
        const result = await updateInitiativeName(
          env,
          initCommand.name,
          initCommand.newName,
          user
        );
        response = result.message;
        break;
      }
      case "update-description": {
        const result = await updateInitiativeDescription(
          env,
          initCommand.name,
          initCommand.newDescription,
          user
        );
        response = result.message;
        break;
      }
      case "update-owner": {
        const result = await updateInitiativeOwner(
          env,
          initCommand.name,
          initCommand.newOwner,
          user
        );
        response = result.message;
        break;
      }
      case "add-metric": {
        const result = await addInitiativeMetric(
          env,
          initCommand.name,
          initCommand.metric,
          user
        );
        response = result.message;
        break;
      }
      case "remove": {
        const result = await removeInitiative(env, initCommand.name);
        response = result.message;
        break;
      }
      case "sync-linear": {
        await postMessage(channel, "🔄 Syncing initiatives from Linear...", threadTs, env);
        const result = await syncLinearProjects(env, user);
        response = result.message;
        break;
      }
    }

    await postMessage(channel, response, threadTs, env);
  },
};
