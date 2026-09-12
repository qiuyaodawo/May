#!/usr/bin/env node
import { runMaybeClaw } from "./run.js";

const controller = new AbortController();
const interrupt = () => controller.abort("Interrupted");
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try { process.exitCode = await runMaybeClaw(process.argv.slice(2), { signal: controller.signal }); }
finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
