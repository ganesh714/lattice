const CORE_TOOLS = [
    {
        name: "list_directory_tree",
        description: "Returns a clean JSON-like structure of folders and files. Use this to map the project layout.",
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
        description: "Reads an ENTIRE file (up to 500 lines). Use this for files under 500 lines to get complete context in one call. Preferred over read_file_chunk for understanding full file behavior.",
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
        description: "Performs a regex-based search across the workspace. Use simple patterns such as 'server', 'url', 'localhost', 'http', or a variable name. Avoid complex escaped URL regexes; use read_file_chunk when the active file path and line range are known.",
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "The regex pattern to search for." }
            },
            required: ["pattern"]
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

