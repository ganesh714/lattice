export const LATTICE_TOOLS = [
    {
        name: "list_directory",
        description: "Lists the files and folders inside a specific directory within the workspace. Use this to understand the project structure.",
        parameters: {
            type: "object",
            properties: {
                relative_path: {
                    type: "string",
                    description: "The path to the directory to list."
                }
            },
            required: ["relative_path"]
        }
    },
    {
        name: "read_file",
        description: "Reads the content of a file within the workspace. Use this to inspect source code or text files.",
        parameters: {
            type: "object",
            properties: {
                relative_path: {
                    type: "string",
                    description: "The path to the file to read."
                }
            },
            required: ["relative_path"]
        }
    },
    {
        name: "modify_file",
        description: "Modifies an existing file by replacing a block of text. Use this to edit or update code/content inside a file.",
        parameters: {
            type: "object",
            properties: {
                relative_path: {
                    type: "string",
                    description: "The path to the file to modify."
                },
                old_text: {
                    type: "string",
                    description: "The exact text to be replaced. Must match exactly what is in the file."
                },
                new_text: {
                    type: "string",
                    description: "The new text to insert in place of the old_text."
                }
            },
            required: ["relative_path", "old_text", "new_text"]
        }
    },
    {
        name: "search_in_files",
        description: "Searches for a specific string or pattern across all files in the workspace. Use this to find variables, configurations, or specific code snippets.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The text or string to search for."
                }
            },
            required: ["query"]
        }
    }
];
