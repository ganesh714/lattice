const CORE_TOOLS = [
    {
        name: "list_directory_tree",
        description: "Returns a visual tree of folders and files with line counts. Files over 400 lines are marked ⚠️ LARGE. Use this to map the project layout.",
        parameters: {
            type: "object",
            properties: {
                relative_path: { type: "string", description: "The directory to scan." },
                depth: { type: "number", description: "How many levels deep to scan." }
            },
            required: ["relative_path"]
        }
    },
    {
        name: "read_file_chunk",
        description: "Reads specific lines from a file to save tokens. Recommended for large source files.",
        parameters: {
            type: "object",
            properties: {
                relative_path: { type: "string", description: "The file path." },
                start_line: { type: "number", description: "Start line number (1-indexed)." },
                end_line: { type: "number", description: "End line number." }
            },
            required: ["relative_path", "start_line", "end_line"]
        }
    },
    {
        name: "read_full_file",
        description: "Reads an ENTIRE file (up to 400 lines). If the file exceeds 400 lines, it will NOT return the content — use analyze_large_file instead.",
        parameters: {
            type: "object",
            properties: {
                relative_path: { type: "string", description: "The file path to read in full." }
            },
            required: ["relative_path"]
        }
    },
    {
        name: "edit_file_diff",
        description: "The SAFEST way to edit code. Replaces an exact 'search_block' with a 'replace_block'. Always include 3 lines of surrounding code in the search block to ensure the correct match.",
        parameters: {
            type: "object",
            properties: {
                relative_path: { type: "string", description: "The file path." },
                search_block: { type: "string", description: "The exact code block to find (include indentation)." },
                replace_block: { type: "string", description: "The new code block to insert." }
            },
            required: ["relative_path", "search_block", "replace_block"]
        }
    },
    {
        name: "search_workspace_regex",
        description: "Performs a regex search across the workspace OR within a specific file. VERY USEFUL for large files: search for '<script', 'function', or 'class' inside a specific file to find relevant line numbers before using read_file_chunk.",
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "The regex pattern to search for." },
                relative_path: { type: "string", description: "Optional. The specific file to search inside." }
            },
            required: ["pattern"]
        }
    },
    {
        name: "analyze_large_file",
        description: "Uses FileIntelligenceAgent to semantically analyze a large file (over 400 lines). Extracts a high-level skeleton and symbol index (functions, classes, etc.) to help you understand the file structure without reading every line. The directory tree marks these files with ⚠️ LARGE.",
        parameters: {
            type: "object",
            properties: {
                relative_path: { type: "string", description: "The file path to analyze." }
            },
            required: ["relative_path"]
        }
    },
    {
        name: "deep_dive_symbol",
        description: "Fetches the raw source code of a specific symbol from a previously analyzed large file. Returns numbered lines you can read directly — no LLM overhead. You MUST call analyze_large_file first.",
        parameters: {
            type: "object",
            properties: {
                relative_path: { type: "string", description: "The file path." },
                symbol_name: { type: "string", description: "The exact symbol name to deep dive into." }
            },
            required: ["relative_path", "symbol_name"]
        }
    },
    {
        name: "get_workspace_diagnostics",
        description: "Pulls all active IDE errors and warnings. Use this for 'Self-Healing'.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        name: "execute_command",
        description: "Executes a shell command in the integrated terminal. Use this for building, testing, or running scripts.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to execute." }
            },
            required: ["command"]
        }
    }
];

export let LATTICE_TOOLS = [...CORE_TOOLS];

export function resetTools() {
    LATTICE_TOOLS.length = 0;
    LATTICE_TOOLS.push(...CORE_TOOLS);
}

export function registerMcpTool(tool: any) {
    LATTICE_TOOLS.push(tool);
}

