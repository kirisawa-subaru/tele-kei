import { describe, expect, it } from "vitest";

import {
  buildLatexSummarySvg,
  renderLatexFormulaImage,
  renderLatexSummaryImage,
} from "../src/latex-renderer.js";

describe("LaTeX summary rendering", () => {
  it("builds one white SVG card containing every formula", async () => {
    const result = await buildLatexSummarySvg([
      "E=mc^2",
      "\\int_0^1 x^2\\,dx=\\frac{1}{3}",
    ]);

    expect(result.width).toBe(1200);
    expect(result.height).toBeGreaterThan(180);
    expect(result.svg).toContain('fill="#ffffff"');
    expect(result.svg.match(/<svg x=/g)).toHaveLength(2);
    expect(result.svg).toContain("\\text{(1)}");
    expect(result.svg).toContain("\\text{(2)}");
  });

  it("renders a single 1x PNG and reports its dimensions", async () => {
    const markdown = [
      "Inline $x_i^2$.",
      "$$E=mc^2$$",
      "\\[\\frac{a}{b}=c\\]",
    ].join("\n\n");
    const image = await renderLatexSummaryImage(markdown);

    expect(image).not.toBeNull();
    expect(image?.formulaCount).toBe(2);
    expect(image?.width).toBe(1200);
    expect(image?.buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(image?.buffer.readUInt32BE(16)).toBe(image?.width);
    expect(image?.buffer.readUInt32BE(20)).toBe(image?.height);
  });

  it("returns null when the answer has only inline TeX", async () => {
    await expect(renderLatexSummaryImage("Inline $x_i^2$ only.")).resolves.toBeNull();
  });

  it("renders caller-provided numbering that continues across cards", async () => {
    const image = await renderLatexFormulaImage([
      { number: 4, tex: "d=4" },
      { number: 5, tex: "e=5" },
      { number: 6, tex: "f=6" },
    ]);

    expect(image.formulaCount).toBe(3);
    expect(image.buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
