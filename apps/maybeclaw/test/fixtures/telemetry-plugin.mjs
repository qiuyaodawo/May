import { createObservabilityPlugin } from "@sortedyuan/observability/plugin";

const definition = createObservabilityPlugin({ dataDirectory: process.cwd() });
export default {
  ...definition,
  setup(context) {
    return createObservabilityPlugin(context.config).setup(context);
  },
};
