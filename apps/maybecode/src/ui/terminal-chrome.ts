import {
  Text,
  sanitizeTerminalText,
  styleText,
  type Component,
  type RenderResult,
  type RenderSize,
  type TuiTheme,
} from "@sortedyuan/tui";

export class HeaderView implements Component {
  constructor(
    private readonly workspace: string,
    private readonly model: string,
    private readonly theme: TuiTheme,
  ) {}

  render(size: RenderSize): RenderResult {
    const title =
      `${styleText("◆", this.theme.accent)} ` +
      `${styleText("MaybeCode", this.theme.accent)}  ` +
      styleText(sanitizeTerminalText(this.model), this.theme.muted);
    const workspace =
      `${styleText("workspace", this.theme.dim)}  ` + styleText(sanitizeTerminalText(this.workspace), this.theme.muted);
    const divider = styleText("─".repeat(size.width), this.theme.border);
    return new Text(`${title}\n${workspace}\n${divider}`, { wrap: false }).render(size);
  }
}

export class FooterView implements Component {
  constructor(
    private readonly yolo: boolean,
    private readonly status: string,
    private readonly focus: string | undefined,
    private readonly details: "all" | "off" | "custom",
    private readonly reasoning: boolean,
    private readonly theme: TuiTheme,
    private readonly replyHint: string,
    private readonly detailsHint: string,
    private readonly thinkingHint: string,
    private readonly gitLabel: string,
  ) {}

  render(size: RenderSize): RenderResult {
    const statusStyle = /^error/iu.test(this.status)
      ? this.theme.error
      : /running|cancell/iu.test(this.status)
        ? this.theme.warning
        : this.theme.success;
    const value =
      (this.gitLabel ? `${styleText(this.gitLabel, this.theme.accent)}  ` : "") +
      (this.yolo ? `${styleText("YOLO · Auto-approve", this.theme.warning)}  ` : "") +
      `${styleText("●", statusStyle)} ${styleText(this.status, statusStyle)}  ` +
      `${styleText(this.focus ?? "none", this.theme.muted)}  ` +
      `${styleText(this.replyHint, this.theme.dim)} reply  ` +
      (this.focus === "transcript"
        ? `${styleText("J/K", this.theme.dim)} tools  ` +
          `${styleText("Enter", this.theme.dim)} toggle  ` +
          `${styleText("↑/↓", this.theme.dim)} scroll  ` +
          `${styleText("Tab", this.theme.dim)} editor`
        : `${styleText(this.detailsHint, this.theme.dim)} details:${this.details}  ` +
          `${styleText(this.thinkingHint, this.theme.dim)} thinking:${this.reasoning ? "on" : "off"}  ` +
          `${styleText("Ctrl+C", this.theme.dim)} copy/cancel`);
    return new Text(value, { wrap: false }).render(size);
  }
}
