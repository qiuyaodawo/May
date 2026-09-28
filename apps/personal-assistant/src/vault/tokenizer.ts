/**
 * 中英文混排分词：拉丁字母与数字按词切分，CJK 连续文本同时产出单字与相邻二字组合。
 * 索引与查询共用该函数，保证两侧词形一致。
 */
const LATIN = /[\p{Script=Latin}\p{Nd}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  let word = "";
  let cjk = "";

  const flushWord = () => {
    if (word !== "") {
      tokens.push(word);
      word = "";
    }
  };
  const flushCjk = () => {
    if (cjk === "") return;
    for (let index = 0; index < cjk.length; index += 1) {
      tokens.push(cjk[index]!);
      if (index + 1 < cjk.length) tokens.push(cjk.slice(index, index + 2));
    }
    cjk = "";
  };

  for (const character of normalized) {
    if (CJK.test(character)) {
      flushWord();
      cjk += character;
      continue;
    }
    if (LATIN.test(character)) {
      flushCjk();
      word += character;
      continue;
    }
    flushWord();
    flushCjk();
  }
  flushWord();
  flushCjk();
  return tokens;
}
