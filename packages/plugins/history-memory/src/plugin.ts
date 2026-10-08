import { applicationHooks, applicationServices } from "@may/application";
import {
  ModelContextCompactionStrategy, PruneOldToolResultsStrategy, SummaryTailStrategy,
  type ContextBudget, type ContextCompactionOptions, type ContextCompactionOutput,
  type ContextCompactionStrategy, type ContextSummarizer,
} from "@may/context";
import type { ContextSnapshot, Model } from "@may/core";
import { definePlugin, defineService } from "@may/plugin";
import { HistoryReferenceMemory, type SavedNotes } from "./history-memory.js";
import { createModelContextSummarizer } from "./summarizer.js";
import type { AutoCompactionMode } from "./index.js";

export interface HistoryMemoryService {
  readonly memory: HistoryReferenceMemory;
  readonly manual: ContextCompactionStrategy;
  readonly summary: ContextCompactionStrategy;
  readonly historyReference: ContextCompactionStrategy;
  readonly native: ContextCompactionStrategy | undefined;
}

export const historyMemoryService = defineService<HistoryMemoryService>({
  id: "may.history-memory", version: "1.0.0", scope: "application",
});

export interface HistoryMemoryPluginOptions {
  readonly mode?: AutoCompactionMode;
  readonly budget?: ContextBudget | ((model: Model) => ContextBudget | undefined);
  readonly summarizer?: ContextSummarizer;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
}

export function createHistoryMemoryPlugin(options: HistoryMemoryPluginOptions = {}) {
  const mode = options.mode ?? "prune-summary";
  return definePlugin({
    id: "may.history-memory", version: "1.0.0", scope: "application",
    provides: [historyMemoryService, applicationServices.contextOptions],
    requires: [
      { service: applicationServices.application }, { service: applicationServices.model },
      { service: applicationServices.modelWrappers }, { service: applicationServices.contextWrappers },
      { service: applicationServices.toolSources },
      { service: applicationServices.instructionSources },
    ],
    requiresHooks: [applicationHooks.created, applicationHooks.inputReceived, applicationHooks.beforeClose],
    state: { version: 1, initial: { notes: null } },
    setup(context) {
      const memory = new HistoryReferenceMemory(mode === "history-reference" && options.autoCompactionStrategies === undefined);
      let strategies: HistoryMemoryService | undefined;
      const current = (effectiveModel?: Model): HistoryMemoryService => {
        if (strategies !== undefined) return strategies;
        const model = effectiveModel ?? context.get(applicationServices.modelWrappers).apply(context.get(applicationServices.model));
        const summary = new SummaryTailStrategy({ summarizer: options.summarizer ?? createModelContextSummarizer(model) });
        strategies = {
          memory, summary, manual: options.compactionStrategy ?? new PruneAndSummaryTailStrategy(summary),
          historyReference: memory.strategy,
          native: model.contextCompactor === undefined ? undefined : new ModelContextCompactionStrategy(model.contextCompactor),
        };
        return strategies;
      };
      context.provide(historyMemoryService, {
        memory,
        get manual() { return current().manual; }, get summary() { return current().summary; },
        get historyReference() { return current().historyReference; }, get native() { return current().native; },
      });
      context.provide(applicationServices.contextOptions, (effectiveModel: Model) => {
        const budget = typeof options.budget === "function" ? options.budget(effectiveModel) : options.budget;
        return {
          ...(budget === undefined ? {} : { budget }),
          ...(options.compactionStrategy === undefined ? {} : { compactionStrategy: options.compactionStrategy }),
          get autoCompactionStrategies() {
            if (options.autoCompactionStrategies !== undefined) return options.autoCompactionStrategies;
            const value = current(effectiveModel);
            if (mode === "history-reference") return [value.historyReference];
            if (mode === "provider-native") {
              if (value.native === undefined) throw new Error("The active model does not support provider-native context compaction");
              return [value.native];
            }
            return [new PruneOldToolResultsStrategy(), value.summary];
          },
        };
      });
      context.defer(context.get(applicationServices.contextWrappers).add(
        factory => memory.wrap(factory, { includeInstructions: false }), { id: context.pluginId, order: 20, pluginOrder: context.pluginOrder },
      ));
      context.defer(context.get(applicationServices.instructionSources).add(
        () => memory.instructions(), { id: context.pluginId, order: 60, pluginOrder: context.pluginOrder },
      ));
      context.defer(context.get(applicationServices.toolSources).add(
        () => memory.tools(), { id: context.pluginId, pluginOrder: context.pluginOrder },
      ));
      context.on(applicationHooks.created, async () => {
        const application = context.get(applicationServices.application).get();
        const saved = context.state.get<{ notes: SavedNotes | null }>().notes;
        const event = [...await application.history()].reverse().find(item => item.type === "state.updated" && item.key === "maybecode.context-notes");
        if (event === undefined && saved !== null) await application.recordState("maybecode.context-notes", saved);
        memory.attach(application, notes => context.state.set({ notes }));
      }, { order: 0 });
      context.on(applicationHooks.inputReceived, () => memory.cancelRequest());
      context.on(applicationHooks.beforeClose, () => memory.cancelRequest());
      context.defer(() => memory.cancelRequest());
    },
  });
}

export class PruneAndSummaryTailStrategy implements ContextCompactionStrategy {
  readonly name = "prune+summary-tail";
  private readonly prune = new PruneOldToolResultsStrategy();
  constructor(private readonly summary: ContextCompactionStrategy) {}
  async compact(snapshot: Readonly<ContextSnapshot>, options: ContextCompactionOptions = {}): Promise<ContextCompactionOutput> {
    return this.summary.compact({ ...snapshot, messages: [...this.prune.compact(snapshot)] }, options);
  }
}
