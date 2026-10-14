import { registerHooks } from "node:module";

const modules = [];
registerHooks({
  load(url, context, nextLoad) {
    modules.push(url);
    return nextLoad(url, context);
  },
});
process.once("exit", () => console.log(`MAY_STARTUP_MODULES=${JSON.stringify(modules)}`));
