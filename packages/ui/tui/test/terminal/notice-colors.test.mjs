import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Text } from "../../dist/index.js";

const require = createRequire(import.meta.url);

test("xterm 续行的 RGB 前景、背景与组合样式保持一致", { timeout: 60000 }, async t => {
  const base = fileURLToPath(new URL("../../../../../review/notice-colors/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "terminal-"));
  const variables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(variables)) process.env[key] = directory;
  t.after(() => {
    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div id="terminal"></div>');
  await page.addScriptTag({ path: require.resolve("@xterm/xterm") });
  await page.evaluate(() => {
    window.term = new Terminal({ cols: 24, rows: 50 });
    window.term.open(document.getElementById("terminal"));
  });
  const rendered = new Text("      " + "abcdefghijklmnopqrstuvwxyz".repeat(5), {
    continuationIndent: 2,
    style: { foreground: "#94a3b8", background: "#123456", bold: true, italic: true, underline: true },
  }).render({ width: 24, height: 50 });
  await page.evaluate(value => new Promise(resolve => window.term.write(value, resolve)), rendered.lines.join("\r\n"));
  const rows = await page.evaluate(count => Array.from({ length: count }, (_, y) => {
    const row = window.term.buffer.active.getLine(y);
    const cells = [];
    for (let x = 0; x < window.term.cols; x++) {
      const cell = row.getCell(x);
      if (cell.getChars().trim()) cells.push({ x, fg: cell.getFgColor(), bg: cell.getBgColor(), bold: !!cell.isBold(), italic: !!cell.isItalic(), underline: !!cell.isUnderline() });
    }
    return cells;
  }), rendered.lines.length);
  assert.ok(rows.length > 2);
  for (const row of rows) {
    if (row.length === 0) continue;
    assert.ok(row[0].x >= 6);
    for (const cell of row) assert.deepEqual({ ...cell, x: 0 }, { x: 0, fg: 0x94a3b8, bg: 0x123456, bold: true, italic: true, underline: true });
  }
});
