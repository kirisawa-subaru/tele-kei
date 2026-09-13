export type LatexSpanKind = "inline" | "display";

export interface LatexSpan {
  start: number;
  end: number;
  raw: string;
  tex: string;
  kind: LatexSpanKind;
  syntax: "dollar" | "bracket" | "paren" | "fence";
}

export interface NumberedLatexFormula {
  number: number;
  tex: string;
  copyText: string;
}

export interface LatexMessageGroup {
  markdown: string;
  sourceMarkdown: string;
  formulas: NumberedLatexFormula[];
}

export const MAX_BLOCK_FORMULAS_PER_MESSAGE = 3;

export function findLatexSpans(text: string): LatexSpan[] {
  const spans: LatexSpan[] = [];
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("```", index)) {
      const tickCount = countRun(text, index, "`");
      const fence = "`".repeat(tickCount);
      const headerEnd = text.indexOf("\n", index + tickCount);
      if (headerEnd === -1) break;
      const close = findClosingFence(text, fence, headerEnd + 1);
      if (close === -1) break;

      const language = text
        .slice(index + tickCount, headerEnd)
        .trim()
        .split(/\s+/, 1)[0]
        ?.toLowerCase();
      const end = close + tickCount;
      if (language === "latex") {
        const tex = normalizeDisplayTex(text.slice(headerEnd + 1, close).trim());
        if (tex) {
          spans.push({
            start: index,
            end,
            raw: text.slice(index, end),
            tex,
            kind: "display",
            syntax: "fence",
          });
        }
      }
      index = end;
      continue;
    }

    if (text[index] === "`") {
      const tickCount = countRun(text, index, "`");
      const fence = "`".repeat(tickCount);
      const close = text.indexOf(fence, index + tickCount);
      index = close === -1 ? index + tickCount : close + tickCount;
      continue;
    }

    if (text.startsWith("$$", index) && !isEscaped(text, index)) {
      const close = findUnescaped(text, "$$", index + 2);
      if (close !== -1) {
        const end = close + 2;
        const tex = text.slice(index + 2, close).trim();
        if (tex) {
          spans.push({
            start: index,
            end,
            raw: text.slice(index, end),
            tex,
            kind: "display",
            syntax: "dollar",
          });
        }
        index = end;
        continue;
      }
      index += 2;
      continue;
    }

    if (text.startsWith("\\[", index) && !isEscaped(text, index)) {
      const close = findUnescaped(text, "\\]", index + 2);
      if (close !== -1) {
        const end = close + 2;
        const tex = text.slice(index + 2, close).trim();
        if (tex) {
          spans.push({
            start: index,
            end,
            raw: text.slice(index, end),
            tex,
            kind: "display",
            syntax: "bracket",
          });
        }
        index = end;
        continue;
      }
      index += 2;
      continue;
    }

    if (text.startsWith("\\(", index) && !isEscaped(text, index)) {
      const close = findUnescaped(text, "\\)", index + 2, true);
      if (close !== -1) {
        const end = close + 2;
        const tex = text.slice(index + 2, close).trim();
        if (tex) {
          spans.push({
            start: index,
            end,
            raw: text.slice(index, end),
            tex,
            kind: "inline",
            syntax: "paren",
          });
        }
        index = end;
        continue;
      }
      index += 2;
      continue;
    }

    if (text[index] === "$" && !isEscaped(text, index)) {
      const close = findUnescaped(text, "$", index + 1, true);
      if (close !== -1) {
        const end = close + 1;
        const tex = text.slice(index + 1, close).trim();
        if (tex) {
          spans.push({
            start: index,
            end,
            raw: text.slice(index, end),
            tex,
            kind: "inline",
            syntax: "dollar",
          });
        }
        index = end;
        continue;
      }
    }

    index += 1;
  }

  return spans;
}

export function extractBlockLatex(text: string): string[] {
  return findLatexSpans(text)
    .filter((span) => span.kind === "display")
    .map((span) => span.tex);
}

export function planLatexMessageGroups(
  text: string,
  maxFormulas = MAX_BLOCK_FORMULAS_PER_MESSAGE,
): LatexMessageGroup[] {
  if (!Number.isInteger(maxFormulas) || maxFormulas < 1) {
    throw new Error("maxFormulas must be a positive integer");
  }

  const displays = findLatexSpans(text)
    .filter((span) => span.kind === "display")
    .map((span, index) => ({
      ...span,
      number: index + 1,
    }));
  if (displays.length === 0) return [];

  const groups: LatexMessageGroup[] = [];
  for (let startIndex = 0; startIndex < displays.length; startIndex += maxFormulas) {
    const spans = displays.slice(startIndex, startIndex + maxFormulas);
    const sourceStart = startIndex === 0 ? 0 : displays[startIndex - 1].end;
    const isLastGroup = startIndex + maxFormulas >= displays.length;
    const sourceEnd = isLastGroup ? text.length : spans.at(-1)!.end;
    let cursor = sourceStart;
    let markdown = "";

    for (const span of spans) {
      markdown += text.slice(cursor, span.start);
      markdown += `[${span.number}]`;
      cursor = span.end;
    }
    markdown += text.slice(cursor, sourceEnd);

    groups.push({
      markdown: markdown.trim(),
      sourceMarkdown: text.slice(sourceStart, sourceEnd).trim(),
      formulas: spans.map((span) => ({
        number: span.number,
        tex: span.tex,
        copyText: span.raw.trim(),
      })),
    });
  }

  return groups;
}

function findClosingFence(text: string, fence: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const close = text.indexOf(fence, index);
    if (close === -1) return -1;
    if (close === 0 || text[close - 1] === "\n") return close;
    index = close + fence.length;
  }
  return -1;
}

function findUnescaped(
  text: string,
  needle: string,
  from: number,
  stopAtNewline = false,
): number {
  let index = from;
  while (index < text.length) {
    const found = text.indexOf(needle, index);
    if (found === -1) return -1;
    if (stopAtNewline && text.slice(index, found).includes("\n")) return -1;
    if (!isEscaped(text, found)) return found;
    index = found + needle.length;
  }
  return -1;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function countRun(text: string, index: number, character: string): number {
  let count = 0;
  while (text[index + count] === character) count += 1;
  return count;
}

function normalizeDisplayTex(tex: string): string {
  const trimmed = tex.trim();
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]") && trimmed.length >= 4) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}
