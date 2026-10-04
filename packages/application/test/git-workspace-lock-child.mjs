import { ProjectGitWorkspace } from "../dist/git-workspace.js";

const workspace = await ProjectGitWorkspace.open(JSON.parse(process.argv[2]));
await workspace.beginRound({ sessionId: "child-process" });
process.send({ ready: true });
setInterval(() => {}, 1000);
