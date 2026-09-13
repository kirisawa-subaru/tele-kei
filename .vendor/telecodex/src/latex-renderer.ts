import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import MathJax from "mathjax";

import { extractBlockLatex, type NumberedLatexFormula } from "./latex.js";

const CARD_WIDTH = 1200;
const CARD_PADDING = 64;
const FORMULA_GAP = 48;
const MAX_CARD_HEIGHT = 6000;
const BASE_PX_PER_UNIT = 0.054;
const MAX_CACHE_ENTRIES = 16;
const MAX_RENDER_BYTES = 20 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 20_000;

type MathJaxRuntime = {
  tex2svgPromise(tex: string, options: { display: boolean }): Promise<unknown>;
  startup: {
    adaptor: {
      serializeXML(node: unknown): string;
    };
  };
};

type ParsedSvg = {
  viewBox: [number, number, number, number];
  body: string;
};

type FormulaLayout = ParsedSvg & {
  width: number;
  height: number;
  x: number;
  y: number;
};

export interface LatexSummaryImage {
  buffer: Buffer;
  fileName: "latex-summary.png";
  formulaCount: number;
  width: number;
  height: number;
}

const mathJaxPromise = MathJax.init({
  loader: { load: ["input/tex", "output/svg"] },
  svg: { fontCache: "none" },
}) as Promise<MathJaxRuntime>;

const imageCache = new Map<string, LatexSummaryImage>();

export async function renderLatexSummaryImage(markdown: string): Promise<LatexSummaryImage | null> {
  const formulas = extractBlockLatex(markdown);
  if (formulas.length === 0) return null;

  return renderLatexFormulaImage(
    formulas.map((tex, index) => ({ tex, number: index + 1 })),
  );
}

export async function renderLatexFormulaImage(
  formulas: ReadonlyArray<Pick<NumberedLatexFormula, "number" | "tex">>,
): Promise<LatexSummaryImage> {
  if (formulas.length === 0) {
    throw new Error("Cannot render a LaTeX image without formulas");
  }

  const cacheKey = createHash("sha256")
    .update(JSON.stringify({ formulas, version: 2 }))
    .digest("hex");
  const cached = imageCache.get(cacheKey);
  if (cached) {
    imageCache.delete(cacheKey);
    imageCache.set(cacheKey, cached);
    return cached;
  }

  const built = await buildLatexSummarySvg(formulas);
  const buffer = await convertSvgToPng(built.svg);
  const image: LatexSummaryImage = {
    buffer,
    fileName: "latex-summary.png",
    formulaCount: formulas.length,
    width: built.width,
    height: built.height,
  };
  imageCache.set(cacheKey, image);
  while (imageCache.size > MAX_CACHE_ENTRIES) {
    const oldest = imageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    imageCache.delete(oldest);
  }
  return image;
}

export async function buildLatexSummarySvg(
  formulas: ReadonlyArray<string | Pick<NumberedLatexFormula, "number" | "tex">>,
): Promise<{ svg: string; width: number; height: number }> {
  if (formulas.length === 0) {
    throw new Error("Cannot build a LaTeX summary image without formulas");
  }

  const mathJax = await mathJaxPromise;
  const parsed: ParsedSvg[] = [];
  for (const [index, input] of formulas.entries()) {
    const formula = typeof input === "string"
      ? { tex: input, number: index + 1 }
      : input;
    const numberedTex = `\\displaystyle ${formula.tex}\\qquad\\text{(${formula.number})}`;
    const node = await mathJax.tex2svgPromise(numberedTex, { display: true });
    parsed.push(parseMathJaxSvg(mathJax.startup.adaptor.serializeXML(node)));
  }

  const maxContentWidth = CARD_WIDTH - 2 * CARD_PADDING;
  let layouts = parsed.map((formula) => layoutFormula(formula, maxContentWidth, BASE_PX_PER_UNIT));
  const gaps = FORMULA_GAP * Math.max(0, layouts.length - 1);
  const naturalContentHeight = layouts.reduce((sum, formula) => sum + formula.height, 0);
  const naturalHeight = 2 * CARD_PADDING + gaps + naturalContentHeight;

  if (naturalHeight > MAX_CARD_HEIGHT) {
    const available = MAX_CARD_HEIGHT - 2 * CARD_PADDING - gaps;
    const shrink = Math.max(0.1, available / naturalContentHeight);
    layouts = layouts.map((formula) => ({
      ...formula,
      width: formula.width * shrink,
      height: formula.height * shrink,
    }));
  }

  let y = CARD_PADDING;
  layouts = layouts.map((formula) => {
    const positioned = {
      ...formula,
      x: (CARD_WIDTH - formula.width) / 2,
      y,
    };
    y += formula.height + FORMULA_GAP;
    return positioned;
  });
  const height = Math.max(180, Math.ceil(y - FORMULA_GAP + CARD_PADDING));

  const formulaSvgs = layouts.map(nestedFormulaSvg).join("\n");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}">`,
    `<rect width="${CARD_WIDTH}" height="${height}" fill="#ffffff"/>`,
    `<g style="color:#111111">`,
    formulaSvgs,
    `</g>`,
    `</svg>`,
  ].join("\n");

  return { svg, width: CARD_WIDTH, height };
}

function parseMathJaxSvg(serialized: string): ParsedSvg {
  const start = serialized.indexOf("<svg");
  const openEnd = serialized.indexOf(">", start);
  const close = serialized.lastIndexOf("</svg>");
  if (start === -1 || openEnd === -1 || close === -1 || close <= openEnd) {
    throw new Error("MathJax returned malformed SVG");
  }

  const opening = serialized.slice(start, openEnd + 1);
  const viewBoxMatch = opening.match(/\bviewBox="([^"]+)"/);
  if (!viewBoxMatch) throw new Error("MathJax SVG is missing a viewBox");
  const values = viewBoxMatch[1].trim().split(/\s+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("MathJax SVG has an invalid viewBox");
  }

  return {
    viewBox: values as [number, number, number, number],
    body: serialized.slice(openEnd + 1, close),
  };
}

function layoutFormula(
  formula: ParsedSvg,
  maxContentWidth: number,
  baseScale: number,
): FormulaLayout {
  const [, , viewWidth, viewHeight] = formula.viewBox;
  const scale = Math.min(baseScale, maxContentWidth / viewWidth);
  return {
    ...formula,
    width: Math.max(1, viewWidth * scale),
    height: Math.max(1, viewHeight * scale),
    x: 0,
    y: 0,
  };
}

function nestedFormulaSvg(formula: FormulaLayout): string {
  const [minX, minY, viewWidth, viewHeight] = formula.viewBox;
  return [
    `<svg x="${round(formula.x)}" y="${round(formula.y)}" width="${round(formula.width)}" height="${round(formula.height)}"`,
    ` viewBox="${minX} ${minY} ${viewWidth} ${viewHeight}" preserveAspectRatio="xMidYMid meet">`,
    formula.body,
    `</svg>`,
  ].join("");
}

function round(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function convertSvgToPng(svg: string): Promise<Buffer> {
  const executable = resolveRsvgConvert();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, ["--format=png"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const finish = (error?: Error, result?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? Buffer.alloc(0));
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`LaTeX PNG rendering timed out after ${RENDER_TIMEOUT_MS}ms`));
    }, RENDER_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RENDER_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("LaTeX PNG rendering exceeded the output limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new Error(`rsvg-convert exited with code ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }
      const result = Buffer.concat(stdout);
      if (!result.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
        finish(new Error("rsvg-convert did not return a PNG"));
        return;
      }
      finish(undefined, result);
    });

    child.stdin.end(svg);
  });
}

function resolveRsvgConvert(): string {
  const configured = process.env.RSVG_CONVERT_PATH?.trim();
  if (configured) return configured;
  for (const candidate of ["/opt/homebrew/bin/rsvg-convert", "/usr/local/bin/rsvg-convert"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "rsvg-convert";
}
