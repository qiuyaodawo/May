import { applicationHooks, applicationServices, type ApplicationFacade } from "@sortedyuan/application";
import { GoalController, type GoalAgent, type GoalOptions, type GoalState } from "@sortedyuan/goal";
import { definePlugin, defineService } from "@sortedyuan/plugin";

export const goalsService = defineService<GoalController>({
  id: "may.goals", version: "1.0.0", scope: "application",
});

export interface GoalsPluginOptions extends GoalOptions {
  readonly createAgent?: (application: ApplicationFacade) => GoalAgent;
}

interface GoalsState { readonly goal: GoalState | null }

export function createGoalsPlugin(options: GoalsPluginOptions = {}) {
  return definePlugin({
    id: "may.goals", version: "1.0.0", scope: "application",
    provides: [goalsService],
    requires: [
      ...(options.createAgent === undefined ? [] : [{ service: applicationServices.application }]),
      { service: applicationServices.execution },
      { service: applicationServices.history },
      { service: applicationServices.state },
      { service: applicationServices.modelWrappers },
      { service: applicationServices.contextWrappers },
      { service: applicationServices.toolSources },
      { service: applicationServices.instructionSources },
    ],
    requiresHooks: [applicationHooks.created, applicationHooks.beforeClose],
    state: { version: 1, initial: { goal: null } },
    setup(context) {
      const controller = new GoalController(options);
      context.provide(goalsService, controller);
      context.defer(() => controller.close());
      context.defer(context.get(applicationServices.modelWrappers).add(
        model => controller.wrapModel(model), { id: context.pluginId, order: 10, pluginOrder: context.pluginOrder },
      ));
      context.defer(context.get(applicationServices.contextWrappers).add(
        factory => controller.wrapContextFactory(factory, { includeInstructions: false }), { id: context.pluginId, order: 10, pluginOrder: context.pluginOrder },
      ));
      context.defer(context.get(applicationServices.instructionSources).add(
        () => controller.instructions(), { id: context.pluginId, order: 40, pluginOrder: context.pluginOrder },
      ));
      context.defer(context.get(applicationServices.toolSources).add(
        () => controller.tools(), { id: context.pluginId, pluginOrder: context.pluginOrder },
      ));
      context.on(applicationHooks.created, async () => {
        const history = context.get(applicationServices.history).get();
        const state = context.get(applicationServices.state).get();
        const agent = options.createAgent === undefined ? context.get(applicationServices.execution).get() :
          options.createAgent(context.get(applicationServices.application).get());
        await controller.attach(agent, {
          read: async () => {
            const saved = context.state.get<GoalsState>().goal;
            if (saved !== null) return saved;
            const event = [...await history.history()].reverse().find(
              item => item.type === "state.updated" && item.key === "may.goal",
            );
            return event?.type === "state.updated" ? event.value as GoalState : undefined;
          },
          write: async goal => {
            await context.state.set({ goal });
            await state.recordState("may.goal", goal);
          },
        });
      }, { order: 20 });
      context.on(applicationHooks.beforeClose, () => controller.close(), { order: 10 });
    },
  });
}
