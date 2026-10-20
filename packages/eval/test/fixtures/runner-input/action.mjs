import { rename, writeFile } from "node:fs/promises";
await writeFile("result.txt", "completed\n");
if (process.argv[2] === "fail") process.exitCode = 2;
if (process.argv[2] === "private-output") process.stdout.write("private-candidate-value");
if (process.argv[2] === "hang") {
  const pending = `process.${process.pid}.pending`;
  await writeFile(pending, JSON.stringify({ pid: process.pid }), { flag: "wx" });
  await rename(pending, "process.json");
  setInterval(() => {}, 1_000);
}
