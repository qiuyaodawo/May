import { SkillSession, type SkillRegistry } from "@may/skills";
import { definePlugin, type PluginDefinition, type PluginContext } from "@may/plugin";
import { services, factoryMetadata, type PluginFactoryMetadata } from "@may/plugin-services";

export interface SkillsPluginOptions<C = unknown> extends Omit<PluginFactoryMetadata<C>, "state"> {
  readonly id?: string;
  readonly create: (context: PluginContext<C>) => SkillRegistry | Promise<SkillRegistry>;
}
export function createSkillsPlugin<C = unknown>(options: SkillsPluginOptions<C>): PluginDefinition<C> {
  return definePlugin({ ...factoryMetadata(options, [{ service: services.toolSources }, { service: services.instructionSources }]), id: options.id ?? "may.skills", provides: [services.skills],
    state: { version: 1, initial: [] }, async setup(context) {
      const skills = new SkillSession(await options.create(context));
      skills.restore(context.state.get());
      skills.setSink((documents) => context.state.set(documents));
      context.provide(services.skills, skills);
      const registration = { id: context.pluginId, pluginOrder: context.pluginOrder };
      context.defer(context.get(services.toolSources).add(() => [skills.readTool()], registration));
      context.defer(context.get(services.instructionSources).add(() => skills.instructions(), { ...registration, order: 0 }));
    },
  });
}
