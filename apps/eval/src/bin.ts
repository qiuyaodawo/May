import { runCli } from "./run.js";
import { formatCliError } from "./errors.js";

const controller = new AbortController();
const interrupt = () => controller.abort("Interrupted by host");
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
} catch (error) {
  console.error(formatCliError(error));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
