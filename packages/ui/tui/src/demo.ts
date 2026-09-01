import type { KeyStroke } from "@may/keybindings";
import {
  Editor,
  FocusManager,
  FullscreenRenderer,
  NodeTerminalDriver,
  SelectList,
  Stack,
  Text,
  TuiRuntime,
  type InteractiveComponent,
  type RenderResult,
  type RenderSize,
} from "./index.js";

const terminal = new NodeTerminalDriver();
const renderer = new FullscreenRenderer(terminal);
let runtime: TuiRuntime;

class DemoView implements InteractiveComponent {
  private readonly focus = new FocusManager();
  private status = "Ready";
  private readonly choices = new SelectList([
    { value: "deepseek", label: "DeepSeek", description: "provider adapter" },
    { value: "glm", label: "GLM", description: "provider adapter" },
    { value: "kimi", label: "Kimi", description: "provider adapter" },
  ], {
    onSelect: (item) => this.status = `Selected ${item.label}`,
  });
  private readonly editor = new Editor({
    placeholder: "Type 中文 or another message…",
    onSubmit: (value) => {
      this.status = value.trim() === "" ? "Nothing submitted" : `Submitted: ${value}`;
      this.editor.setValue("");
    },
  });

  constructor() {
    this.focus.register("providers", this.choices);
    this.focus.register("editor", this.editor);
    this.focus.focus("editor");
  }

  render(size: RenderSize): RenderResult {
    return new Stack([
      new Text("May TUI interactive foundation"),
      new Text("Unicode: 中文 · こんにちは · 🚀"),
      new Text(() => `Focus: ${this.focus.focusedId} · ${this.status}`),
      this.choices,
      this.editor,
      new Text("Tab/Shift+Tab changes focus · Enter acts · Ctrl+C exits"),
    ], { gap: 1 }).render(size);
  }

  handleKey(stroke: KeyStroke): boolean {
    if (stroke.ctrl && stroke.key === "c") {
      runtime.stop();
      return false;
    }
    if (stroke.key === "tab") {
      return stroke.shift ? this.focus.focusPrevious() : this.focus.focusNext();
    }
    return this.focus.dispatch(stroke);
  }
}

runtime = new TuiRuntime({
  terminal,
  renderer,
  root: new DemoView(),
});
runtime.start();
