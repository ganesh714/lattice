import { ModelFactory } from "../../../models/ModelFactory";
import { ChatRequest } from "../../../types/schemas";
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
    return response.content;
  }
  return "";
}

export async function extractSkeleton(
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
- lines field must reference the original file line numbers

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
    for (const chunk of chunks) {
      const systemInstruction = `You are indexing a ${language} file chunk. Extract all symbols.`;
      const prompt = `
Extract all symbols (functions, classes, selectors, components, etc.) from this chunk.

Return ONLY a JSON array (no markdown):
[{ "type": "...", "name": "...", "lines": "${chunk.startLine}-${chunk.endLine}", "description": "..." }]

CHUNK (lines ${chunk.startLine}–${chunk.endLine}):
\`\`\`${language}
${chunk.content}
\`\`\`
`;
      try {
        const raw = await callModel(workspacePath, modelName, systemInstruction, prompt);
        const cleaned = raw.replace(/```json|```/g, "").trim();
        const parsed: Symbol[] = JSON.parse(cleaned);
        for (const sym of parsed) {
          if (!allSymbols.find((s) => s.name === sym.name)) {
            allSymbols.push(sym);
          }
        }
      } catch {
        // Skip failed chunk silently
      }
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

export async function deepDive(
  workspacePath: string,
  modelName: string,
  content: string,
  language: SupportedLanguage,
  symbolName: string,
  index: SymbolIndex
): Promise<string> {
  const symbol = index.symbols.find(
    (s) => s.name.toLowerCase() === symbolName.toLowerCase()
  );

  if (!symbol) {
    return \`Symbol "\${symbolName}" not found in index. Available: \${index.symbols
      .map((s) => s.name)
      .join(", ")}\`;
  }

  const [startStr, endStr] = symbol.lines.split("-");
  const start = Math.max(0, parseInt(startStr, 10) - 1);
  const end = Math.min(
    content.split("\n").length,
    parseInt(endStr, 10) + 10
  );
  const excerpt = content.split("\n").slice(start, end).join("\n");

  const systemInstruction = `Deeply analyze this ${language} code excerpt.`;
  const prompt = `
Deeply analyze this ${language} code excerpt (symbol: "${symbolName}"):

\`\`\`${language}
${excerpt}
\`\`\`

Provide:
1. Purpose and responsibility
2. Inputs / parameters / dependencies
3. Outputs / side effects
4. Any notable patterns or issues
5. How it connects to other parts of the codebase (based on names/imports you see)

Be concise and technical.
`;

  return await callModel(workspacePath, modelName, systemInstruction, prompt);
}
