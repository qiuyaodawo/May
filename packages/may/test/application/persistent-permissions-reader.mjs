import { FileSessionStore } from "@sortedyuan/may/session/file-store";

const history = await new FileSessionStore(process.argv[2]).read(process.argv[3]);
process.stdout.write(JSON.stringify({ types: history.map(event => event.type), ruleIds: history.filter(event => event.type === "rule.created").map(event => event.rule.id) }));
