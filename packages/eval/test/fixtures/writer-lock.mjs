import { FileEvalStore } from "../../dist/file-store.js";
const store = new FileEvalStore({ directory: process.argv[2] });
await store.acquire("locked");
process.stdout.write("ready\n");
setInterval(() => {}, 1_000);
