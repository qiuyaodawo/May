#!/usr/bin/env node

import { runCli } from "./cli.js";

const controller = new AbortController();
const interrupt = () => controller.abort("Interrupted by user");
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
