import * as vscode from "vscode";
import { TextDecoder } from "util";
import { detectLanguage } from "./LanguageDetector";
import { chunkFile } from "./Chunker";
import { SymbolIndex, AnalysisResult, Symbol } from "./Types";
import { extractSkeleton, buildSymbolIndex, extractSymbolCode } from "./AnalyzerPasses";

export class FileIntelligenceAgent {
  // Shared cache across the extension session
  private static indexCache = new Map<string, SymbolIndex>();

  /**
   * Full multi-pass analysis of a file.
   * 
   * Pass 1: Skeleton — uses VS Code DocumentSymbolProvider (instant, free).
   *         Falls back to LLM only if the provider returns nothing.
   * Pass 2: Symbol Index — enriches with per-chunk LLM indexing for multi-chunk files.
   * Pass 3: (optional) Raw code extraction for a specific symbol — NO LLM call.
   */
  static async analyze(
    workspacePath: string,
    filePath: string,
    modelName: string,
    options: { deepDiveSymbol?: string; chunkSize?: number } = {}
  ): Promise<AnalysisResult> {
    const targetUri = vscode.Uri.file(filePath);
    let uint8Array: Uint8Array;
    try {
      uint8Array = await vscode.workspace.fs.readFile(targetUri);
    } catch (e: any) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = new TextDecoder().decode(uint8Array);
    const language = detectLanguage(filePath);
    const chunks = chunkFile(content, language, options.chunkSize ?? 300);

    // Pass 1: Skeleton (DocumentSymbolProvider first, LLM fallback)
    const skeleton = await extractSkeleton(workspacePath, modelName, filePath, content, language);

    // Pass 2: Symbol Index
    const index = await buildSymbolIndex(workspacePath, modelName, filePath, chunks, language, skeleton.symbols);
    FileIntelligenceAgent.indexCache.set(filePath, index);

    const result: AnalysisResult = { file: filePath, language, skeleton, index };

    // Pass 3 (optional): Raw code extraction — NO LLM call
    if (options.deepDiveSymbol) {
      result.deepDive = extractSymbolCode(content, language, options.deepDiveSymbol, index);
    }

    return result;
  }

  /**
   * Fetch only a specific symbol's raw code from an already-indexed file.
   * 
   * Returns the actual source code with line numbers — NO LLM call.
   * The caller (ReAct Planner) is already an LLM that can analyze the code itself.
   */
  static async fetchSymbol(
    workspacePath: string,
    filePath: string,
    modelName: string,
    symbolName: string
  ): Promise<string> {
    const index = FileIntelligenceAgent.indexCache.get(filePath);
    if (!index) {
      throw new Error(`File not indexed yet. Call analyze_large_file first.`);
    }

    const targetUri = vscode.Uri.file(filePath);
    const uint8Array = await vscode.workspace.fs.readFile(targetUri);
    const content = new TextDecoder().decode(uint8Array);
    const language = detectLanguage(filePath);

    return extractSymbolCode(content, language, symbolName, index);
  }

  static getCachedIndex(filePath: string): SymbolIndex | undefined {
    return FileIntelligenceAgent.indexCache.get(filePath);
  }

  /**
   * Formats the result as a string for tool output
   */
  static formatSummary(result: AnalysisResult): string {
    let out = `## File: ${result.file} (${result.language})\n\n`;
    out += `### Skeleton\n${result.skeleton.skeleton}\n\n`;
    out += `### Symbols\n`;
    for (const sym of result.index.symbols) {
      out += `- [${sym.type}] ${sym.name} (lines ${sym.lines})`;
      if (sym.description) out += `: ${sym.description}`;
      out += `\n`;
    }
    if (result.deepDive) {
      out += `\n### Deep Dive\n${result.deepDive}\n`;
    }
    return out;
  }
}
