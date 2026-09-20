declare module "node-ansiparser" {
  export default class AnsiParser {
    constructor(handler: { inst_c(collected: string, params: number[], flag: string): void });
    parse(value: string): void;
    reset(): void;
  }
}
