import { SupportedLanguage } from "./LanguageDetector";

export interface Symbol {
  type: string;
  name: string;
  lines: string;
  description?: string;
}

export interface SymbolIndex {
  file: string;
  language: SupportedLanguage;
  totalLines: number;
  symbols: Symbol[];
  builtAt: string;
}

export interface SkeletonResult {
  language: SupportedLanguage;
  skeleton: string;
  symbols: Symbol[];
}

export interface AnalysisResult {
  file: string;
  language: SupportedLanguage;
  skeleton: SkeletonResult;
  index: SymbolIndex;
  deepDive?: string;
}
