import { readFile } from "node:fs/promises";
if (await readFile("result.txt", "utf8") !== "completed\n") process.exitCode = 2;
