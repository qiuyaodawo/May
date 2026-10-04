import { openConfiguredMaybeCode } from "../../../dist/index.js";

const [workspace, dataDirectory] = process.argv.slice(2);
const app = await openConfiguredMaybeCode({ git: false, workspace, dataDirectory, model: "deepseek-v4-flash",
  autoResume: false, mcp: false, observability: false, skills: false, retry: false });
console.log(`SESSION:${app.sessionId}`);
const events = (async () => {
  for await (const event of app.events) {
    if (event.type === "goal.changed" && event.goal.calls.some(call => call.status === "pending")) console.log("PENDING");
  }
})();
await app.startGoal("Read the first 3 lines of README.md and report its first heading through update_goal completed. Do not use shell or modify files.", { maxTotalTokens: 20000 });
await events;
