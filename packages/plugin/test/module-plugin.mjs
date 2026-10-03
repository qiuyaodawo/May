export default {
  id: "module-state",
  version: "1.0.0",
  state: { version: 1, initial: { opened: 0 } },
  configSchema: {
    type: "object",
    properties: { increment: { type: "integer", minimum: 1 } },
    required: ["increment"],
    additionalProperties: false,
  },
  async setup(ctx) {
    await ctx.state.update((value) => ({ opened: value.opened + ctx.config.increment }));
  },
};
