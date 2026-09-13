import { describe, expect, it } from "vitest";

import {
  extractBlockLatex,
  findLatexSpans,
  planLatexMessageGroups,
} from "../src/latex.js";

describe("LaTeX extraction", () => {
  it("collects all supported display syntaxes in source order", () => {
    const markdown = [
      "Inline $x_i^2$ remains text.",
      "",
      "$$E=mc^2$$",
      "",
      "\\[\\int_0^1 x^2\\,dx=\\frac{1}{3}\\]",
      "",
      "```latex",
      "\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}",
      "```",
    ].join("\n");

    expect(extractBlockLatex(markdown)).toEqual([
      "E=mc^2",
      "\\int_0^1 x^2\\,dx=\\frac{1}{3}",
      "\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}",
    ]);
    expect(findLatexSpans(markdown).map((span) => span.kind)).toEqual([
      "inline",
      "display",
      "display",
      "display",
    ]);
  });

  it("ignores formulas inside ordinary code fences and inline code", () => {
    const markdown = [
      "`$$not-math$$`",
      "```js",
      "const sample = '$$also-not-math$$';",
      "```",
      "$$real_math$$",
    ].join("\n");

    expect(extractBlockLatex(markdown)).toEqual(["real_math"]);
  });

  it("does not collect unclosed delimiters", () => {
    expect(extractBlockLatex("before $$x + y")).toEqual([]);
    expect(findLatexSpans("before $x + y")).toEqual([]);
  });

  it("normalizes display delimiters nested inside a latex fence", () => {
    expect(extractBlockLatex("```latex\n$$x^2$$\n```")).toEqual(["x^2"]);
    expect(extractBlockLatex("```latex\n\\[x^2\\]\n```")).toEqual(["x^2"]);
  });

  it("replaces block sources with numbered references and groups three at a time", () => {
    const markdown = [
      "Intro with inline $x_i$.",
      "$$a=1$$",
      "between one and two",
      "\\[b=2\\]",
      "```latex",
      "c=3",
      "```",
      "bridge text before the fourth formula",
      "$$d=4$$",
      "after four",
      "$$e=5$$",
      "$$f=6$$",
      "tail",
    ].join("\n\n");

    const groups = planLatexMessageGroups(markdown);

    expect(groups).toHaveLength(2);
    expect(groups[0].markdown).toContain("Intro with inline $x_i$.");
    expect(groups[0].markdown).toContain("[1]");
    expect(groups[0].markdown).toContain("[2]");
    expect(groups[0].markdown).toContain("[3]");
    expect(groups[0].markdown).not.toContain("bridge text before the fourth formula");
    expect(groups[0].markdown).not.toContain("$$a=1$$");
    expect(groups[0].formulas.map((formula) => formula.number)).toEqual([1, 2, 3]);
    expect(groups[0].formulas.map((formula) => formula.copyText)).toEqual([
      "$$a=1$$",
      "\\[b=2\\]",
      "```latex\n\nc=3\n\n```",
    ]);
    expect(groups[1].markdown).toContain("[4]");
    expect(groups[1].markdown).toContain("[5]");
    expect(groups[1].markdown).toContain("[6]");
    expect(groups[1].markdown).toContain("tail");
    expect(groups[1].markdown).toContain("bridge text before the fourth formula");
    expect(groups[1].formulas.map((formula) => formula.number)).toEqual([4, 5, 6]);
  });

  it("rejects invalid group sizes and returns no groups for inline-only TeX", () => {
    expect(planLatexMessageGroups("Inline $x$ only.")).toEqual([]);
    expect(() => planLatexMessageGroups("$$x$$", 0)).toThrow(
      "maxFormulas must be a positive integer",
    );
  });
});
