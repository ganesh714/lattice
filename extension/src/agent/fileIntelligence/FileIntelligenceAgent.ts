import * as vscode from "vscode";
import { TextDecoder } from "util";
import { detectLanguage } from "./LanguageDetector";
import { chunkFile } from "./Chunker";
import { SymbolIndex, AnalysisResult, Symbol } from "./Types";
import { extractSkeleton, buildSymbolIndex, deepDive } from "./AnalyzerPasses";

export class FileIntelligenceAgent {
  // Shared cache across the extension session
  private static indexCache = new Map<string, SymbolIndex>();

  /**
   * Full multi-pass analysis of a file.
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

    // Pass 1: Skeleton
    const skeleton = await extractSkeleton(workspacePath, modelName, filePath, content, language);

    // Pass 2: Symbol Index
    const index = await buildSymbolIndex(workspacePath, modelName, filePath, chunks, language, skeleton.symbols);
    FileIntelligenceAgent.indexCache.set(filePath, index);

    const result: AnalysisResult = { file: filePath, language, skeleton, index };

    // Pass 3 (optional): Deep dive
    if (options.deepDiveSymbol) {
      result.deepDive = await deepDive(workspacePath, modelName, content, language, options.deepDiveSymbol, index);
    }

    return result;
  }

  /**
   * Fetch only a specific symbol from an already-indexed file.
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

    return await deepDive(workspacePath, modelName, content, language, symbolName, index);
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
