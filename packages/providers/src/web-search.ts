import { createHash } from "node:crypto";
import type { Message, ModelRequest, ModelState } from "@sortedyuan/may/core";
import type { ProviderModelSelection } from "./types.js";
import { ProviderConfigurationError, ServerToolStateMismatchError } from "./errors.js";

/** @experimental */
export interface WebSearchOptions {
  readonly version?: "web_search_20250305" | "web_search_20260209" | "web_search_20260318";
  readonly maxUses?: number;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly userLocation?: {
    readonly city?: string;
    readonly region?: string;
    readonly country?: string;
    readonly timezone?: string;
  };
  readonly allowedCallers?: readonly string[];
  readonly responseInclusion?: "full" | "none";
  readonly searchContextSize?: "low" | "medium" | "high";
  readonly timeRange?: { readonly startTime: string; readonly endTime: string };
  readonly searchTypes?: readonly ("web" | "image")[];
  readonly searchEngine?: "search_std" | "search_pro" | "search_pro_sogou" | "search_pro_quark";
  readonly count?: number;
  readonly domainFilter?: string;
  readonly recencyFilter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
  readonly contentSize?: "medium" | "high";
  readonly searchPrompt?: string;
}

const fields: Readonly<Record<string, readonly string[]>> = {
  "anthropic-messages": [
    "version",
    "maxUses",
    "allowedDomains",
    "blockedDomains",
    "userLocation",
    "allowedCallers",
    "responseInclusion",
  ],
  "openai-responses": ["allowedDomains", "blockedDomains", "userLocation", "searchContextSize"],
  "openai-chat-completions": ["searchContextSize", "userLocation"],
  "google-gemini": ["timeRange", "searchTypes"],
  "zhipu-chat": ["searchEngine", "count", "domainFilter", "recencyFilter", "contentSize", "searchPrompt"],
};

export function selectionWebSearch(selection: ProviderModelSelection): unknown {
  return Object.hasOwn(selection.options, "webSearch")
    ? selection.options.webSearch
    : selection.providerConfig.options?.webSearch;
}

export function validateWebSearch(adapter: string, value: unknown): false | WebSearchOptions | undefined {
  if (value === undefined) return undefined;
  if (!fields[adapter]) throw new ProviderConfigurationError(`${adapter} does not accept webSearch`);
  if (value === false) return false;
  const invalid = (message: string): never => {
    throw new ProviderConfigurationError(`webSearch: ${message}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("must be false or an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!fields[adapter]!.includes(key)) invalid(`unsupported field ${key}`);
  for (const key of ["allowedDomains", "blockedDomains", "allowedCallers", "searchTypes"]) {
    const items = record[key];
    if (
      items !== undefined &&
      (!Array.isArray(items) ||
        items.length === 0 ||
        new Set(items).size !== items.length ||
        items.some((item) => typeof item !== "string" || item.trim() === ""))
    )
      invalid(`${key} must contain unique nonempty strings`);
  }
  if (record.allowedDomains !== undefined && record.blockedDomains !== undefined) {
    invalid("allowedDomains and blockedDomains are mutually exclusive");
  }
  for (const key of ["maxUses", "count"]) {
    if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || (record[key] as number) < 1)) {
      invalid(`${key} must be a positive safe integer`);
    }
  }
  for (const key of ["responseInclusion", "domainFilter", "recencyFilter", "contentSize", "searchPrompt"]) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || (record[key] as string).trim() === "")) {
      invalid(`${key} must be a nonempty string`);
    }
  }
  const enums: Readonly<Record<string, readonly string[]>> = {
    version: ["web_search_20250305", "web_search_20260209", "web_search_20260318"],
    responseInclusion: ["full", "none"],
    searchContextSize: ["low", "medium", "high"],
    recencyFilter: ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"],
    contentSize: ["medium", "high"],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || !allowed.includes(record[key]))) {
      invalid(`invalid ${key}`);
    }
  }
  if (record.responseInclusion !== undefined && record.version !== "web_search_20260318") {
    invalid("responseInclusion requires web_search_20260318");
  }
  if (
    record.allowedCallers !== undefined &&
    (record.allowedCallers as string[]).some((caller) => !["direct", "code_execution_20260120"].includes(caller))
  )
    invalid("invalid allowedCallers");
  if (record.userLocation !== undefined) {
    const location = record.userLocation;
    if (
      typeof location !== "object" ||
      location === null ||
      Array.isArray(location) ||
      Object.keys(location).length === 0
    ) {
      invalid("userLocation must contain at least one field");
    }
    for (const [key, item] of Object.entries(location as object)) {
      if (!["city", "region", "country", "timezone"].includes(key) || typeof item !== "string" || item.trim() === "") {
        invalid("invalid userLocation field");
      }
    }
  }
  if (record.timeRange !== undefined) {
    const range = record.timeRange as Record<string, unknown>;
    if (
      typeof range !== "object" ||
      range === null ||
      Array.isArray(range) ||
      Object.keys(range).some((key) => !["startTime", "endTime"].includes(key)) ||
      typeof range.startTime !== "string" ||
      typeof range.endTime !== "string" ||
      !Number.isFinite(Date.parse(range.startTime)) ||
      !Number.isFinite(Date.parse(range.endTime)) ||
      Date.parse(range.startTime) > Date.parse(range.endTime)
    )
      invalid("timeRange requires valid startTime and endTime");
  }
  if (Array.isArray(record.searchTypes) && record.searchTypes.some((item) => item !== "web" && item !== "image")) {
    invalid("invalid searchTypes");
  }
  if (
    adapter === "zhipu-chat" &&
    !["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"].includes(String(record.searchEngine))
  ) {
    invalid("searchEngine is required");
  }
  return structuredClone(record) as WebSearchOptions;
}

export function webSearchRequest(adapter: string, options: WebSearchOptions): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  const add = (key: string, value: unknown) => {
    if (value !== undefined) mapped[key] = value;
  };
  if (adapter === "anthropic-messages") {
    Object.assign(mapped, { type: options.version ?? "web_search_20250305", name: "web_search" });
    add("max_uses", options.maxUses);
    add("allowed_domains", options.allowedDomains);
    add("blocked_domains", options.blockedDomains);
    add("allowed_callers", options.allowedCallers);
    add("response_inclusion", options.responseInclusion);
  } else if (adapter === "openai-responses") {
    mapped.type = "web_search";
    if (options.allowedDomains !== undefined) mapped.filters = { allowed_domains: options.allowedDomains };
    if (options.blockedDomains !== undefined) mapped.filters = { blocked_domains: options.blockedDomains };
  } else if (adapter === "google-gemini") {
    const googleSearch: Record<string, unknown> = {};
    if (options.timeRange !== undefined) googleSearch.timeRangeFilter = options.timeRange;
    if (options.searchTypes !== undefined) {
      googleSearch.searchTypes = Object.fromEntries(options.searchTypes.map((type) => [`${type}Search`, {}]));
    }
    return { googleSearch };
  } else if (adapter === "zhipu-chat") {
    const search: Record<string, unknown> = { enable: true, search_result: true, search_engine: options.searchEngine };
    for (const [key, value] of [
      ["count", options.count],
      ["search_domain_filter", options.domainFilter],
      ["search_recency_filter", options.recencyFilter],
      ["content_size", options.contentSize],
      ["search_prompt", options.searchPrompt],
    ] as const)
      if (value !== undefined) search[key] = value;
    return { type: "web_search", web_search: search };
  }
  add("search_context_size", options.searchContextSize);
  if (options.userLocation !== undefined) {
    mapped.user_location =
      adapter === "openai-chat-completions"
        ? { type: "approximate", approximate: { ...options.userLocation } }
        : { type: "approximate", ...options.userLocation };
  }
  return mapped;
}

/** @experimental */
export interface ServerToolOrigin {
  readonly adapter: string;
  readonly model: string;
  readonly baseURL: string;
  readonly toolsHash: string;
}

export function serverToolOrigin(adapter: string, model: string, baseURL: string, tools: unknown): ServerToolOrigin {
  const serialized = JSON.stringify(tools ?? null, (_key, value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value,
  );
  return { adapter, model, baseURL, toolsHash: createHash("sha256").update(serialized).digest("hex") };
}

export function unfinishedServerMessage(messages: readonly Message[]) {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  return last?.role === "assistant" &&
    (last.continuation !== undefined || last.serverToolCalls?.some((call) => call.status === "pending"))
    ? last
    : undefined;
}

export function assertServerToolOrigin(request: ModelRequest, origin: ServerToolOrigin): void {
  const message = unfinishedServerMessage(request.messages);
  if (message === undefined) return;
  const data = message.modelState?.data as { origin?: ServerToolOrigin } | undefined;
  if (
    data?.origin?.adapter !== origin.adapter ||
    data.origin.model !== origin.model ||
    data.origin.baseURL !== origin.baseURL ||
    data.origin.toolsHash !== origin.toolsHash
  )
    throw new ServerToolStateMismatchError();
}

export function withServerToolOrigin(state: ModelState, origin: ServerToolOrigin): ModelState {
  return { ...state, data: { ...(state.data as object), origin } };
}
