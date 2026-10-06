import { createObservabilityPlugin } from "@may/plugin-observability";

const definition = createObservabilityPlugin({ dataDirectory: process.cwd() });
export default {
  ...definition,
  setup(context) {
    return createObservabilityPlugin(context.config).setup(context);
  },
};
