#!/usr/bin/env node

import { runCli } from "./run.js";

const controller = new AbortController();
const interrupt = () => controller.abort("Interrupted");
process.once("SIGINT", interrupt);

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    signal: controller.signal,
  });
} finally {
  process.removeListener("SIGINT", interrupt);
}
