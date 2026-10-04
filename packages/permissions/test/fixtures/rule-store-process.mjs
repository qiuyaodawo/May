import { FilePermissionRuleStore } from "../../dist/file-store.js";

const [command, path] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const store = await FilePermissionRuleStore.open({ path });
if (command === "create" || command === "crash") {
  await store.create(JSON.parse(input));
  if (command === "crash") process.exit(23);
} else if (command === "list") {
  process.stdout.write(JSON.stringify(await store.list()));
} else if (command === "revoke") {
  process.stdout.write(JSON.stringify(await store.revoke(JSON.parse(input))));
} else {
  throw new Error(`Unknown command: ${command}`);
}
await store.close();
