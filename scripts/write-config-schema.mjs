import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const applications = {
  maybecode: { directory: "apps/maybecode", title: "MaybeCode configuration" },
  maybeclaw: { directory: "apps/maybeclaw", title: "MaybeClaw configuration" },
};
const id = process.argv[2];
const application = applications[id];
if (application === undefined)
  throw new Error(`Usage: write-config-schema.mjs <${Object.keys(applications).join("|")}>`);
const repository = new URL("../", import.meta.url);
const { createApplicationConfigSchema } = await import(new URL("packages/may/dist/config/index.js", repository).href);
const output = new URL(`${application.directory}/dist/`, repository);
const section = JSON.parse(await readFile(new URL("config-schema.json", output), "utf8"));
await writeFile(
  fileURLToPath(new URL(`${id}-config.schema.json`, output)),
  JSON.stringify(createApplicationConfigSchema(id, section, application.title), null, 2) + "\n",
);
