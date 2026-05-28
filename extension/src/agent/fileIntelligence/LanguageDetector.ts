import * as path from "path";

export type SupportedLanguage =
  | "html"
  | "css"
  | "javascript"
  | "typescript"
  | "python"
  | "java"
  | "csharp"
  | "cpp"
  | "c"
  | "dart"
  | "flutter"
  | "rust"
  | "go"
  | "php"
  | "ruby"
  | "swift"
  | "kotlin"
  | "scala"
  | "vue"
  | "svelte"
  | "json"
  | "markdown"
  | "yaml"
  | "shell"
  | "unknown";

export function detectLanguage(filePath: string): SupportedLanguage {
  const ext = path.extname(filePath).toLowerCase();
  const langMap: Record<string, SupportedLanguage> = {
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "css",
    ".less": "css",
    ".js": "javascript",
    ".mjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".java": "java",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".dart": "dart",
    ".rs": "rust",
    ".go": "go",
    ".php": "php",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".scala": "scala",
    ".vue": "vue",
    ".svelte": "svelte",
    ".json": "json",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell"
  };
  return langMap[ext] ?? "unknown";
}

export const BoundaryPatterns: Partial<Record<SupportedLanguage, RegExp>> = {
  html: /^\s*<(section|div|header|footer|main|nav|article|aside|form|table|script|style)/i,
  css: /^\s*[.#\[\*]?[a-zA-Z][^{]*\{/,
  javascript: /^\s*(function|class|const\s+\w+\s*=\s*(async\s+)?\(|export\s+(default\s+)?(function|class|const|async))/,
  typescript: /^\s*(function|class|interface|type\s+\w+|const\s+\w+\s*=\s*(async\s+)?\(|export\s+(default\s+)?(function|class|const|interface|type|async))/,
  python: /^\s*(def |class |async def )/,
  java: /^\s*(public|private|protected|static|abstract|final|class|interface|enum|record)\s/,
  csharp: /^\s*(public|private|protected|internal|static|abstract|sealed|class|interface|enum|struct|namespace|record)\s/,
  cpp: /^\s*(class |struct |namespace |[a-zA-Z][a-zA-Z0-9_:*&\s]+\s+[a-zA-Z_]\w*\s*\()/,
  c: /^\s*([a-zA-Z_]\w*\s+\**[a-zA-Z_]\w*\s*\()/,
  dart: /^\s*(class |void |Future|Stream|Widget|@override|[a-zA-Z]+\s+\w+\()/,
  flutter: /^\s*(class |void |Future|Stream|Widget|@override|[a-zA-Z]+\s+\w+\()/,
  rust: /^\s*(pub\s+)?(fn|struct|enum|trait|impl|mod)\s/,
  go: /^\s*(func|type)\s/,
  php: /^\s*(public|private|protected|static|abstract|final|class|interface|trait|function)\s/,
  ruby: /^\s*(def|class|module)\s/,
  swift: /^\s*(public|private|fileprivate|internal|open|class|struct|enum|protocol|extension|func)\s/,
  kotlin: /^\s*(public|private|protected|internal|abstract|final|open|class|interface|enum|object|fun)\s/,
  scala: /^\s*(class|object|trait|def|val|var|type)\s/,
  vue: /^\s*<(template|script|style)/i,
  svelte: /^\s*<(script|style)/i
};
