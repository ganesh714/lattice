# FileIntelligenceAgent Documentation

The `FileIntelligenceAgent` is a specialized sub-agent designed to solve the problem of analyzing large files (e.g., 500+ lines) that typically overwhelm a standard Language Model's context window. Instead of forcing the LLM to read a large file blindly in chunks, this agent uses a **semantic multi-pass strategy** to extract a structural skeleton and an indexed list of symbols.

## Architecture

The agent is located in `src/agent/fileIntelligence/` and is divided into several modules for organization and maintainability:

### 1. `LanguageDetector.ts`
Detects the programming language of a file based on its extension. It exports a large dictionary of `BoundaryPatterns`—Regex expressions specifically crafted to find semantic boundaries (like `class`, `function`, `<section>`, etc.) for over 20+ programming languages.

### 2. `Chunker.ts`
Responsible for slicing a large file into smaller, logical chunks. 
- It uses the Regex patterns from the `LanguageDetector` to ensure chunks are split cleanly between functions or classes rather than breaking randomly in the middle of a code block.
- For unsupported languages, it falls back to a fixed-size line chunking strategy.

### 3. `AnalyzerPasses.ts`
Contains the core prompts and integrates with the extension's `ModelFactory` to process the chunks via AI (Groq, Gemini, Ollama, etc.). It executes three distinct passes:
- **Pass 1 (Skeleton Extraction):** Reads the file (or a truncated version of it) and extracts a high-level outline of the file's structure.
- **Pass 2 (Symbol Indexing):** Iterates over the chunks and extracts all symbols (functions, classes, interfaces, CSS selectors, HTML tags) along with their exact line numbers.
- **Pass 3 (Deep Dive):** Optional pass. Analyzes a specific, targeted excerpt of code based on the symbol index.

### 4. `FileIntelligenceAgent.ts`
The main orchestrator class. It coordinates the chunking and the passes. Crucially, it contains an **`indexCache`** (a `Map`) to cache the symbol index across the extension session, ensuring that if an agent wants to deep-dive into multiple symbols in the same file, the file is only indexed once.

---

## Agent Tools

The `FileIntelligenceAgent` is exposed to the planner agents (like `ReActPlanner`) via two tools registered in `ToolRegistry.ts`:

### 1. `analyze_large_file`
- **Purpose**: Used when an agent encounters a file that is too large to read fully (usually >500 lines).
- **Parameters**: `relative_path`
- **Behavior**: Runs Pass 1 and Pass 2. Returns a concise markdown summary containing the file's skeleton and a list of all symbols with their line numbers.

### 2. `deep_dive_symbol`
- **Purpose**: Used *after* `analyze_large_file` to fetch a deep-dive analysis of a specific component without reading the whole file.
- **Parameters**: `relative_path`, `symbol_name`
- **Behavior**: Uses the cached index to locate the symbol, extracts the specific line range, and runs Pass 3 to analyze its purpose, inputs, outputs, and dependencies.

---

## How to Test Standalone

Because the agent relies on VS Code APIs (`vscode.workspace.fs` and `vscode.workspace.getConfiguration`), it normally cannot be run outside of the extension host. 

To solve this, a standalone testing script is provided at `scripts/test-file-agent.ts` which automatically mocks the VS Code APIs.

### Prerequisites
Set your preferred AI Provider API key in your terminal.
**PowerShell:**
```powershell
$env:GEMINI_API_KEY="your_api_key_here"
# Or
$env:GROQ_API_KEY="your_api_key_here"
```
**Bash/Zsh:**
```bash
export GEMINI_API_KEY="your_api_key_here"
```

### Running the Tests

1. **Test `analyze_large_file` (Passes 1 & 2):**
   This will chunk the file, build the skeleton, index the symbols, and output the summary format that the AI agents see.
   ```bash
   npx ts-node scripts/test-file-agent.ts path/to/large/file.html
   ```

2. **Test `deep_dive_symbol` (Pass 3):**
   This will first build the cache, and then perform a deep dive on the specific symbol you provide.
   ```bash
   npx ts-node scripts/test-file-agent.ts path/to/large/file.html --symbol "someFunctionName"
   ```
