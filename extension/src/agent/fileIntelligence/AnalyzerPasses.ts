import * as vscode from "vscode";
import { ModelFactory } from "../../models/ModelFactory";
import { ChatRequest } from "../../types/schemas";
import { SupportedLanguage } from "./LanguageDetector";
import { FileChunk } from "./Chunker";
import { Symbol, SymbolIndex, SkeletonResult } from "./Types";

async function callModel(
  workspacePath: string,
  modelName: string,
  systemInstruction: string,
  prompt: string
): Promise<string> {
  const request: ChatRequest = {
    prompt,
    model: modelName,
    workspace: workspacePath,
    chat_history: [],
    tool_history: [],
    disableTools: true
  };
  const response = await ModelFactory.generateWithFallback(request, systemInstruction);
  if (response.type === "message") {
    // Strip <think>...</think> tags — models like Qwen3 emit chain-of-thought
    // reasoning inside these tags, which leaks into tool results and wastes
    // hundreds of tokens when stored in toolHistory.
    return response.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }
  return "";
}

// ─── DocumentSymbol → Lattice Symbol Mapper ───────────────────────────────────

function mapDocumentSymbolKind(kind: vscode.SymbolKind): string {
  const kindMap: Record<number, string> = {
    [vscode.SymbolKind.File]: "file",
    [vscode.SymbolKind.Module]: "module",
    [vscode.SymbolKind.Namespace]: "namespace",
    [vscode.SymbolKind.Package]: "package",
    [vscode.SymbolKind.Class]: "class",
    [vscode.SymbolKind.Method]: "method",
    [vscode.SymbolKind.Property]: "property",
    [vscode.SymbolKind.Field]: "field",
    [vscode.SymbolKind.Constructor]: "constructor",
    [vscode.SymbolKind.Enum]: "enum",
    [vscode.SymbolKind.Interface]: "interface",
    [vscode.SymbolKind.Function]: "function",
    [vscode.SymbolKind.Variable]: "variable",
    [vscode.SymbolKind.Constant]: "constant",
    [vscode.SymbolKind.String]: "string",
    [vscode.SymbolKind.Number]: "number",
    [vscode.SymbolKind.Boolean]: "boolean",
    [vscode.SymbolKind.Array]: "array",
    [vscode.SymbolKind.Object]: "object",
    [vscode.SymbolKind.Key]: "key",
    [vscode.SymbolKind.Null]: "null",
    [vscode.SymbolKind.EnumMember]: "enum_member",
    [vscode.SymbolKind.Struct]: "struct",
    [vscode.SymbolKind.Event]: "event",
    [vscode.SymbolKind.Operator]: "operator",
    [vscode.SymbolKind.TypeParameter]: "type_parameter",
  };
  return kindMap[kind] ?? "symbol";
}

/**
 * Recursively flattens VS Code's DocumentSymbol tree into a flat list of Lattice Symbols.
 */
function flattenDocumentSymbols(docSymbols: vscode.DocumentSymbol[], depth = 0): Symbol[] {
  const symbols: Symbol[] = [];
  for (const sym of docSymbols) {
    const startLine = sym.range.start.line + 1; // VS Code is 0-indexed, we use 1-indexed
    const endLine = sym.range.end.line + 1;
    symbols.push({
      type: mapDocumentSymbolKind(sym.kind),
      name: sym.name,
      lines: `${startLine}-${endLine}`,
      description: sym.detail || undefined,
    });
    // Recurse into children (methods inside classes, etc.)
    if (sym.children && sym.children.length > 0) {
      symbols.push(...flattenDocumentSymbols(sym.children, depth + 1));
    }
  }
  return symbols;
}

/**
 * Builds a concise structural skeleton string from DocumentSymbols.
 * Shows nesting with indentation, similar to what the LLM used to produce.
 */
function buildSkeletonFromSymbols(docSymbols: vscode.DocumentSymbol[], indent = ""): string {
  const lines: string[] = [];
  for (const sym of docSymbols) {
    const startLine = sym.range.start.line + 1;
    const endLine = sym.range.end.line + 1;
    const detail = sym.detail ? ` — ${sym.detail}` : "";
    lines.push(`${indent}[${mapDocumentSymbolKind(sym.kind)}] ${sym.name} (L${startLine}-${endLine})${detail}`);
    if (sym.children && sym.children.length > 0) {
      lines.push(buildSkeletonFromSymbols(sym.children, indent + "  "));
    }
  }
  return lines.join("\n");
}

// ─── Pass 1: Skeleton Extraction (VS Code first, LLM fallback) ───────────────

export async function extractSkeleton(
  workspacePath: string,
  modelName: string,
  filePath: string,
  content: string,
  language: SupportedLanguage
): Promise<SkeletonResult> {

  // ── Strategy A: Use VS Code's built-in DocumentSymbolProvider (instant, free) ──
  try {
    const uri = vscode.Uri.file(filePath);
    const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri
    );

    if (docSymbols && docSymbols.length > 0) {
      const symbols = flattenDocumentSymbols(docSymbols);
      const skeleton = buildSkeletonFromSymbols(docSymbols);
      console.log(`[FileIntelligence] Skeleton extracted via DocumentSymbolProvider: ${symbols.length} symbols`);
      return { language, skeleton, symbols };
    }
  } catch (e: any) {
    console.warn(`[FileIntelligence] DocumentSymbolProvider failed for ${filePath}: ${e.message}`);
  }

  // ── Strategy B: LLM fallback (for languages without symbol provider support) ──
  console.log(`[FileIntelligence] DocumentSymbolProvider returned nothing for ${filePath}, falling back to LLM skeleton extraction`);
  return await extractSkeletonViaLLM(workspacePath, modelName, filePath, content, language);
}

/**
 * LLM-based skeleton extraction — only used when VS Code's DocumentSymbolProvider
 * returns no results (e.g., plain HTML, CSS without proper language extensions).
 */
async function extractSkeletonViaLLM(
  workspacePath: string,
  modelName: string,
  filePath: string,
  content: string,
  language: SupportedLanguage
): Promise<SkeletonResult> {
  const systemInstruction = `You are a code analysis expert. Given a file, extract ONLY the high-level skeleton.`;
  const prompt = `
Given the following ${language} file, extract ONLY the high-level skeleton.

Return a JSON object with this exact shape (no markdown, no extra text):
{
  "skeleton": "<concise structural outline as a string, max 60 lines>",
  "symbols": [
    {
      "type": "<section|function|class|interface|variable|mixin|rule|widget|component|etc>",
      "name": "<symbol name or id>",
      "lines": "<startLine-endLine>",
      "description": "<one-line description>"
    }
  ]
}

Rules:
- Do NOT include method bodies or CSS property values
- For HTML: list every major section/component with its id/class
- For CSS: list every selector rule block
- For JS/TS: list every function, class, interface, exported const
- For Python: list every def and class
- For Java/C#: list every class and method signature
- For C/C++: list every function signature and class
- For Dart/Flutter: list every Widget class and method
- CRITICAL: lines field MUST reference the exact, specific start and end line for every single symbol independently. Do NOT group or summarize line ranges. Guessing is strictly forbidden.

FILE PATH: ${filePath}
LANGUAGE: ${language}
TOTAL LINES: ${content.split("\n").length}

FILE CONTENT:
\`\`\`${language}
${content.substring(0, 12000)}${content.length > 12000 ? "\n... (truncated for skeleton pass)" : ""}
\`\`\`
`;

  const raw = await callModel(workspacePath, modelName, systemInstruction, prompt);

  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      language,
      skeleton: parsed.skeleton ?? "",
      symbols: parsed.symbols ?? [],
    };
  } catch {
    return {
      language,
      skeleton: raw.substring(0, 2000),
      symbols: [],
    };
  }
}

// ─── Pass 2: Build Symbol Index ───────────────────────────────────────────────

export async function buildSymbolIndex(
  workspacePath: string,
  modelName: string,
  filePath: string,
  chunks: FileChunk[],
  language: SupportedLanguage,
  skeletonSymbols: Symbol[]
): Promise<SymbolIndex> {
  const allSymbols: Symbol[] = [...skeletonSymbols];

  if (chunks.length > 1) {
    // Run all chunks in parallel — small models have lower context limits so
    // we guard each chunk's content size before sending.
    // Promise.allSettled means one bad chunk never blocks the rest.
    const MAX_CHUNK_CHARS = 8000; // Safe for small models (~2k tokens)

    const chunkResults = await Promise.allSettled(
      chunks.map(async (chunk) => {
        const safeContent = chunk.content.length > MAX_CHUNK_CHARS
          ? chunk.content.substring(0, MAX_CHUNK_CHARS) + '\n... (truncated)'
          : chunk.content;

        const systemInstruction = `You are indexing a ${language} file chunk. Extract all symbols.`;
        const prompt = `
Extract all symbols (functions, classes, selectors, components, etc.) from this chunk.

Return ONLY a JSON array (no markdown):
[{ "type": "...", "name": "...", "lines": "${chunk.startLine}-${chunk.endLine}", "description": "..." }]

CRITICAL RULE: The "lines" field MUST be exactly scoped to the symbol. Do not use the full chunk range if the symbol is smaller. Do not group multiple symbols into one line range.

CHUNK (lines ${chunk.startLine}–${chunk.endLine}):
\`\`\`${language}
${safeContent}
\`\`\`
`;
        const raw = await callModel(workspacePath, modelName, systemInstruction, prompt);
        const cleaned = raw.replace(/```json|```/g, "").trim();
        return JSON.parse(cleaned) as Symbol[];
      })
    );

    for (const result of chunkResults) {
      if (result.status === 'fulfilled') {
        for (const sym of result.value) {
          if (!allSymbols.find((s) => s.name === sym.name)) {
            allSymbols.push(sym);
          }
        }
      }
      // Rejected chunks are silently skipped — skeleton symbols still provide coverage
    }
  }

  return {
    file: filePath,
    language,
    totalLines: chunks.reduce((acc, c) => Math.max(acc, c.endLine), 0),
    symbols: allSymbols,
    builtAt: new Date().toISOString(),
  };
}

// ─── Pass 3: Extract Symbol Code (Raw — No LLM Call) ─────────────────────────

/**
 * Extracts the raw source code for a symbol from the file.
 * Returns numbered lines ready for the planner to analyze directly.
 * 
 * NO LLM CALL — the ReAct Planner is already an LLM; it can analyze
 * the code itself within its own context window.
 */
export function extractSymbolCode(
  content: string,
  language: SupportedLanguage,
  symbolName: string,
  index: SymbolIndex
): string {
  const symbol = index.symbols.find(
    (s) => s.name.toLowerCase() === symbolName.toLowerCase()
  );

  if (!symbol) {
    return `Symbol "${symbolName}" not found in index. Available: ${index.symbols
      .map((s) => s.name)
      .join(", ")}`;
  }

  const lines = content.split("\n");
  const [startStr, endStr] = symbol.lines.split("-");
  let start = Math.max(0, parseInt(startStr, 10) - 1);
  // Include a small buffer after the symbol to capture closing braces/brackets
  let end = Math.min(lines.length, parseInt(endStr, 10) + 5);

  // Fix C: Validate that the extracted range actually contains the symbol name.
  // LLM-based skeleton extraction can hallucinate line numbers, causing deep_dive_symbol
  // to return code for the WRONG symbol (e.g., asking for "applyThemeSynchronized" but
  // getting "clearErrors" because the index has wrong line numbers).
  const excerpt = lines.slice(start, end);
  const excerptText = excerpt.join("\n");
  if (!excerptText.includes(symbolName)) {
    // Fallback: search the entire file for the symbol name
    const fallbackStart = lines.findIndex(line => line.includes(symbolName));
    if (fallbackStart !== -1) {
      // Found the symbol — extract a reasonable window around it
      start = Math.max(0, fallbackStart - 2);
      end = Math.min(lines.length, fallbackStart + 50);
      const fallbackExcerpt = lines.slice(start, end);
      const numbered = fallbackExcerpt
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n");
      return `## Symbol: ${symbolName} [${symbol.type}] (lines ${start + 1}-${end}) [corrected from index ${symbol.lines}]\n\`\`\`${language}\n${numbered}\n\`\`\``;
    }
    // Symbol name not found anywhere — return the indexed range with a warning
    const numbered = excerpt
      .map((line, i) => `${start + i + 1}: ${line}`)
      .join("\n");
    return `## Symbol: ${symbolName} [${symbol.type}] (lines ${symbol.lines}) [WARNING: symbol name not found in extracted range — index may have wrong line numbers]\n\`\`\`${language}\n${numbered}\n\`\`\``;
  }

  // Return numbered lines so the planner has precise line references
  const numbered = excerpt
    .map((line, i) => `${start + i + 1}: ${line}`)
    .join("\n");

  return `## Symbol: ${symbolName} [${symbol.type}] (lines ${symbol.lines})\n\`\`\`${language}\n${numbered}\n\`\`\``;
}
