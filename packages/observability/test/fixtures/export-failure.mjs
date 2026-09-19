import assert from "node:assert/strict";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BasicTracer,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  JsonlFileSpanExporter,
} from "../../dist/index.js";

const root = fileURLToPath(new URL("../../../../review/", import.meta.url));
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, "export-failure-"));
const path = join(directory, "spans.jsonl");
const mode = process.argv[2];
let descriptor;

try {
  let exporter;
  if (mode === "sync") {
    await writeFile(path, "");
    descriptor = openSync(path, "r");
    exporter = new ConsoleSpanExporter({ write: (line) => writeSync(descriptor, `${line}\n`) });
  } else {
    assert.equal(mode, "async");
    await mkdir(path);
    exporter = new JsonlFileSpanExporter({ path });
  }

  const errors = [];
  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 1,
    scheduledDelayMs: 60_000,
    onError: (error) => errors.push(error),
  });
  const tracer = new BasicTracer({ processor });
  tracer.startSpan("failed-write").end();
  await processor.forceFlush();
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  assert.equal(typeof errors[0].code, "string");

  if (mode === "sync") {
    closeSync(descriptor);
    descriptor = undefined;
    descriptor = openSync(path, "a");
  } else {
    await rmdir(path);
  }

  tracer.startSpan("after-failure").end();
  await processor.forceFlush();
  tracer.startSpan("shutdown-export").end();
  await processor.shutdown();
  assert.equal(errors.length, 1);
  const spans = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(spans.map((span) => span.name), ["after-failure", "shutdown-export"]);
} finally {
  if (descriptor !== undefined) closeSync(descriptor);
  await rm(directory, { recursive: true, force: true });
}
