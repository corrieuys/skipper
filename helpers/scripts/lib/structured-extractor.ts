import { extname, resolve } from "node:path";
import { readFileSync } from "node:fs";

export interface ExtractorConfig {
  language: string;
  containerKeywords: string[];
  methodKeywordStyle: "brace";
}

export interface LogicalPart {
  kind: string;
  name: string;
  parent: string | null;
  startLine: number;
  endLine: number;
  source: string;
}

export interface ExtractionResult {
  filePath: string;
  language: string;
  logicalParts: LogicalPart[];
}

export function runBraceExtractor(config: ExtractorConfig): void {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(`Usage: bun run ${process.argv[1]?.split("/").pop() ?? "extractor.ts"} <file-path>`);
    process.exit(1);
  }

  const absolutePath = resolve(filePath);
  const source = readFileSync(absolutePath, "utf-8");
  const result = extractBraceLanguage({
    source,
    filePath: absolutePath,
    language: config.language,
    containerKeywords: config.containerKeywords,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function extractBraceLanguage(input: {
  source: string;
  filePath: string;
  language: string;
  containerKeywords: string[];
}): ExtractionResult {
  const lines = input.source.split(/\r?\n/);
  const logicalParts: LogicalPart[] = [];

  logicalParts.push({
    kind: "file",
    name: basenameWithoutExtension(input.filePath),
    parent: null,
    startLine: 1,
    endLine: lines.length,
    source: input.source.trimEnd(),
  });

  const fullText = lines.join("\n");
  const containers = extractContainers(fullText, lines, input.containerKeywords);
  for (const container of containers) {
    logicalParts.push({
      kind: container.kind,
      name: container.name,
      parent: null,
      startLine: container.startLine,
      endLine: container.endLine,
      source: lines.slice(container.startLine - 1, container.endLine).join("\n").trimEnd(),
    });

    const methods = extractMethods(fullText, lines, container);
    for (const method of methods) {
      logicalParts.push({
        kind: "method",
        name: method.name,
        parent: container.name,
        startLine: method.startLine,
        endLine: method.endLine,
        source: lines.slice(method.startLine - 1, method.endLine).join("\n").trimEnd(),
      });
    }
  }

  const topLevelFunctions = extractTopLevelFunctions(fullText, input.language, containers);
  for (const fn of topLevelFunctions) {
    logicalParts.push({
      kind: fn.kind,
      name: fn.name,
      parent: fn.parent,
      startLine: fn.startLine,
      endLine: fn.endLine,
      source: lines.slice(fn.startLine - 1, fn.endLine).join("\n").trimEnd(),
    });
  }

  return {
    filePath: input.filePath,
    language: input.language,
    logicalParts: dedupeParts(logicalParts),
  };
}

function extractContainers(
  fullText: string,
  lines: string[],
  containerKeywords: string[],
): Array<{ kind: string; name: string; startLine: number; endLine: number; startOffset: number; endOffset: number }> {
  const keywordAlternation = containerKeywords.map(escapeRegex).join("|");
  const regex = new RegExp(
    String.raw`(?:^|\n)\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)?(${keywordAlternation})\s+([A-Za-z_][A-Za-z0-9_]*)[^;{]*\{`,
    "g",
  );

  const containers: Array<{ kind: string; name: string; startLine: number; endLine: number; startOffset: number; endOffset: number }> = [];
  for (const match of fullText.matchAll(regex)) {
    const startOffset = (match.index ?? 0) + (match[0].startsWith("\n") ? 1 : 0);
    const openBraceOffset = fullText.indexOf("{", startOffset);
    const closeBraceOffset = findMatchingBrace(fullText, openBraceOffset);
    if (openBraceOffset < 0 || closeBraceOffset < 0) continue;

    containers.push({
      kind: match[1],
      name: match[2],
      startLine: offsetToLine(fullText, startOffset),
      endLine: offsetToLine(fullText, closeBraceOffset),
      startOffset,
      endOffset: closeBraceOffset,
    });
  }

  return containers;
}

function extractMethods(
  fullText: string,
  lines: string[],
  container: { name: string; startOffset: number; endOffset: number; startLine: number },
): Array<{ name: string; startLine: number; endLine: number }> {
  const containerText = fullText.slice(container.startOffset, container.endOffset + 1);
  const regex = /(?:^|\n)\s*(?:(?:public|private|protected|static|async|override|readonly|final|virtual|internal|extern|inline|mut)\s+)*(?:<[A-Za-z0-9_,\s? extendsimplements&]+>\s*)?(?:(?:[A-Za-z_][A-Za-z0-9_<>\[\],.?]*|[|&])\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?::[^{\n]+)?\s*\{/g;
  const methods: Array<{ name: string; startLine: number; endLine: number }> = [];

  for (const match of containerText.matchAll(regex)) {
    const name = match[1];
    if (["if", "for", "while", "switch", "catch"].includes(name)) continue;
    const relativeOffset = (match.index ?? 0) + (match[0].startsWith("\n") ? 1 : 0);
    const absoluteOffset = container.startOffset + relativeOffset;
    const openBraceOffset = fullText.indexOf("{", absoluteOffset);
    const closeBraceOffset = findMatchingBrace(fullText, openBraceOffset);
    if (openBraceOffset < 0 || closeBraceOffset < 0) continue;

    methods.push({
      name,
      startLine: offsetToLine(fullText, absoluteOffset),
      endLine: offsetToLine(fullText, closeBraceOffset),
    });
  }

  return methods;
}

function extractTopLevelFunctions(
  fullText: string,
  language: string,
  containers: Array<{ startOffset: number; endOffset: number }>,
): Array<{ kind: string; name: string; parent: string | null; startLine: number; endLine: number }> {
  const regex = language === "golang"
    ? /(?:^|\n)\s*func\s*(\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    : /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const functions: Array<{ kind: string; name: string; parent: string | null; startLine: number; endLine: number }> = [];

  for (const match of fullText.matchAll(regex)) {
    const startOffset = (match.index ?? 0) + (match[0].startsWith("\n") ? 1 : 0);
    if (containers.some((container) => startOffset > container.startOffset && startOffset < container.endOffset)) {
      continue;
    }

    const openBraceOffset = fullText.indexOf("{", startOffset);
    const closeBraceOffset = findMatchingBrace(fullText, openBraceOffset);
    if (openBraceOffset < 0 || closeBraceOffset < 0) continue;

    const hasReceiver = language === "golang" ? Boolean(match[1]) : false;
    const receiverType = hasReceiver ? extractGoReceiverParent(match[1] ?? "") : null;
    const functionName = language === "golang" ? match[2] : match[1];
    functions.push({
      kind: hasReceiver ? "method" : "function",
      name: functionName,
      parent: receiverType,
      startLine: offsetToLine(fullText, startOffset),
      endLine: offsetToLine(fullText, closeBraceOffset),
    });
  }

  return functions;
}

function extractGoReceiverParent(receiverText: string): string | null {
  const normalized = receiverText.replace(/[()]/g, " ").trim();
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[1].replace(/^\*/, "");
}

function dedupeParts(parts: LogicalPart[]): LogicalPart[] {
  const seen = new Set<string>();
  const result: LogicalPart[] = [];

  for (const part of parts) {
    if (!part.source) continue;
    const key = [part.kind, part.name, part.parent ?? "", part.startLine, part.endLine].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(part);
  }

  return result.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

function basenameWithoutExtension(filePath: string): string {
  const extension = extname(filePath);
  const trimmed = extension ? filePath.slice(0, -extension.length) : filePath;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function offsetToLine(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function findMatchingBrace(text: string, openIndex: number): number {
  if (openIndex < 0 || text[openIndex] !== "{") return -1;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    const prev = text[i - 1];

    if (inSingle) {
      if (char === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (char === "\"" && prev !== "\\") inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (char === "`" && prev !== "\\") inTemplate = false;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === "\"") {
      inDouble = true;
      continue;
    }
    if (char === "`") {
      inTemplate = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
