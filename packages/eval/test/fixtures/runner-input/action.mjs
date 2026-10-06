import { writeFile } from "node:fs/promises";
await writeFile("result.txt", "completed\n");
if (process.argv[2] === "fail") process.exitCode = 2;
if (process.argv[2] === "private-output") process.stdout.write("private-candidate-value");
if (process.argv[2] === "hang") {
  await writeFile("process.json", JSON.stringify({ pid: process.pid }));
  setInterval(() => {}, 1_000);
}
