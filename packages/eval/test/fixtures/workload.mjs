import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode === "write") {
  await writeFile(join(process.cwd(), "result.json"), JSON.stringify({ answer: 42 }));
  console.log("completed");
} else if (mode === "check") {
  const { readFile } = await import("node:fs/promises");
  const value = JSON.parse(await readFile(join(process.cwd(), "result.json"), "utf8"));
  if (value.answer !== 42) throw new Error("Expected answer 42");
} else if (mode === "delay") {
  await new Promise(accept => setTimeout(accept, Number(process.argv[3] ?? 30000)));
} else if (mode === "tree") {
  const child = spawn(process.execPath, [import.meta.filename, "delay", "30000"], { stdio: "inherit", windowsHide: true });
  const identity = JSON.stringify({ parent: process.pid, child: child.pid });
  console.log(identity);
  await writeFile("tree.json.pending", identity);
  await rename("tree.json.pending", "tree.json");
  await new Promise(accept => setTimeout(accept, 30000));
} else if (mode === "orphan") {
  const child = spawn(process.execPath, [import.meta.filename, "orphan-child"], { stdio: "ignore", detached: true, windowsHide: true, cwd: process.cwd() });
  child.unref();
  console.log(JSON.stringify({ child: child.pid }));
} else if (mode === "orphan-child") {
  await writeFile("orphan.txt", "child remained active");
  await new Promise(accept => setTimeout(accept, 30000));
} else if (mode === "fail") {
  throw new Error("Workload failure");
} else if (mode === "output") {
  process.stdout.write("a".repeat(10000));
  process.stderr.write("b".repeat(10000));
} else if (mode === "env") {
  console.log(JSON.stringify({ credentialVisible: process.env.EVAL_PRIVATE_CREDENTIAL !== undefined }));
} else if (mode === "subdirectory") {
  await mkdir("nested");
  await writeFile("nested/result.json", JSON.stringify({ answer: 42 }));
} else {
  throw new Error("Unknown workload");
}
