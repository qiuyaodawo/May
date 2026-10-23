import { createMayConfig } from "../../dist/index.js";

process.once("message", async () => {
  try {
    await createMayConfig(process.argv[2], { providers: {}, apps: { marker: { name: process.argv[3] } } });
    process.exitCode = 0;
  } catch (error) {
    if (error.code !== "MAY_CONFIG_WRITE_ERROR") throw error;
    process.exitCode = 1;
  } finally { process.disconnect(); }
});
process.send("ready");
