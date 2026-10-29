import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export function inspectDocument(source) {
  const text = source.replaceAll("\r\n", "\n");
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const structure = [];
  const sections = [];
  let section = { heading: "preamble", blocks: [] };
  sections.push(section);
  const visit = (node) => {
    if (["list", "listItem", "blockquote", "table"].includes(node.type)) structure.push(["begin", node.type]);
    if (node.type === "heading") structure.push(["heading", node.depth]);
    if (node.type === "list") structure.push(["list", node.ordered, node.start, node.children.length]);
    if (node.type === "table") structure.push(["table", node.children.map(row => row.children.length)]);
    if (node.type === "code") structure.push(["code", node.lang, node.meta]);
    for (const child of node.children ?? []) visit(child);
    if (["list", "listItem", "blockquote", "table"].includes(node.type)) structure.push(["end", node.type]);
  };
  const label = node => node.value ?? (node.children ?? []).map(label).join("");
  for (const node of tree.children) {
    if (node.type === "heading") {
      section = { heading: label(node), blocks: [] };
      sections.push(section);
    }
    visit(node);
    section.blocks.push(text.slice(node.position.start.offset, node.position.end.offset));
  }
  return {
    structure,
    sections: sections.map(({ heading, blocks }) => ({
      heading,
      hash: createHash("sha256").update(blocks.join("\n")).digest("hex"),
    })),
  };
}

export function compareStructure(english, chinese) {
  const errors = [];
  const length = Math.max(english.structure.length, chinese.structure.length);
  for (let index = 0; index < length; index++) {
    const en = english.structure[index];
    const zh = chinese.structure[index];
    if (JSON.stringify(en) !== JSON.stringify(zh)) {
      errors.push(`structure item ${index + 1}: ${JSON.stringify(en)} != ${JSON.stringify(zh)}`);
    }
  }
  return errors;
}
