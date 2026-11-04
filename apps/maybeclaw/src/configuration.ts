import { createApplicationConfigValidator, type MayConfig } from "@sortedyuan/may/config";
import type { GatewayAgentConfig } from "./gateway-types.js";
import section from "./config-schema.json" with { type: "json" };

export type GroupTrigger = "explicit" | "all";
export interface EntranceTrigger { readonly conversation: string; readonly threadId?: string; readonly trigger: GroupTrigger }

export interface ChannelSettings {
  readonly enabled?: boolean;
  readonly allowUsers?: readonly string[];
  readonly allowGroups?: readonly string[];
  readonly groupTrigger?: GroupTrigger;
  readonly entranceTriggers?: readonly EntranceTrigger[];
}

/** The `apps.maybeclaw` entry of a May configuration file, validated against `config-schema.json`. */
export interface MaybeClawSettings {
  readonly version: 2;
  readonly persistentRules?: boolean;
  readonly agents?: readonly GatewayAgentConfig[];
  readonly access?: {
    readonly sessionAdmins?: Readonly<Record<string, readonly string[]>>;
    readonly creators?: readonly string[];
    readonly deniedUsers?: readonly string[];
    readonly allowedAgents?: Readonly<Record<string, readonly string[]>>;
  };
  readonly server?: {
    readonly maxConcurrent?: number;
    readonly auth?: { readonly password?: string; readonly passwordHash?: string; readonly sessionMs?: number };
    readonly idleMs?: number;
    readonly shutdownMs?: number;
    readonly approvalMs?: number;
    readonly publicOrigin?: string;
  };
  readonly channels?: {
    readonly telegram?: ChannelSettings & { readonly botToken?: string; readonly botTokenEnv?: string };
    readonly feishu?: ChannelSettings & { readonly appId?: string; readonly appSecret?: string; readonly appSecretEnv?: string };
  };
}

export const maybeClawConfigSection = section;

const validate = createApplicationConfigValidator<MaybeClawSettings>("maybeclaw", section);

export function readMaybeClawSettings(config: MayConfig): MaybeClawSettings {
  return validate(config.apps?.maybeclaw ?? {}, config.path);
}
