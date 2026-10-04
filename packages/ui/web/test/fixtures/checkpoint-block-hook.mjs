import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = process.env.MAY_UI_CHECKPOINT_SIGNALS;
if (!directory) throw new Error("Checkpoint signal directory is required");
await writeFile(join(directory, "started"), "started\n");
const deadline = Date.now() + 60_000;
while (!existsSync(join(directory, "release"))) {
  if (Date.now() >= deadline) throw new Error("Checkpoint hook release timed out");
  await delay(25);
}
