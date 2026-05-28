import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';

export class FileSystemTools {
    static async listDirectoryTree(workspacePath: string, relativePath: string, depth: number = 2): Promise<string> {
        const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(workspacePath, relativePath);
        const targetUri = vscode.Uri.file(absolutePath);
        const IGNORED = ['node_modules', '.git', 'dist', 'build', '.gemini'];

        async function getLineCount(fileUri: vscode.Uri): Promise<number> {
            try {
                const raw = await vscode.workspace.fs.readFile(fileUri);
                const text = new TextDecoder().decode(raw);
                return text.split('\n').length;
            } catch {
                return -1;
            }
        }

        async function scan(uri: vscode.Uri, prefix: string, currentDepth: number): Promise<string[]> {
            if (currentDepth > Math.min(depth, 3)) return [`${prefix}...`];
            try {
                const entries = await vscode.workspace.fs.readDirectory(uri);
                const filtered = entries.filter(([name]) => !IGNORED.includes(name));
                // Sort: directories first, then files
                filtered.sort((a, b) => {
                    if (a[1] === b[1]) return a[0].localeCompare(b[0]);
                    return a[1] === vscode.FileType.Directory ? -1 : 1;
                });

                const lines: string[] = [];
                for (let i = 0; i < filtered.length; i++) {
                    const [name, type] = filtered[i];
                    const isLast = i === filtered.length - 1;
                    const connector = isLast ? '└── ' : '├── ';
                    const childPrefix = isLast ? '    ' : '│   ';

                    if (type === vscode.FileType.Directory) {
                        lines.push(`${prefix}${connector}${name}/`);
                        const children = await scan(vscode.Uri.joinPath(uri, name), prefix + childPrefix, currentDepth + 1);
                        lines.push(...children);
                    } else {
                        const lineCount = await getLineCount(vscode.Uri.joinPath(uri, name));
                        const sizeLabel = lineCount > 400 ? ` (${lineCount} lines ⚠️ LARGE)` : lineCount > 0 ? ` (${lineCount} lines)` : '';
                        lines.push(`${prefix}${connector}${name}${sizeLabel}`);
                    }
                }
                return lines;
            } catch (e: any) {
                if (e.message?.includes('ENOENT') || e.code === 'FileNotFound') {
                    return [`${prefix}[Directory does not exist: ${uri.fsPath}. You may need to create it.]`];
                }
                return [`${prefix}[Error reading directory: ${e.message}]`];
            }
        }

        const rootName = path.basename(absolutePath) || relativePath;
        const treeLines = await scan(targetUri, '', 0);
        return `${rootName}/\n${treeLines.join('\n')}`;
    }

    static async readFileChunk(workspacePath: string, relativePath: string, startLine: number, endLine: number): Promise<string> {
        const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(workspacePath, relativePath);
        const targetUri = vscode.Uri.file(absolutePath);
        let uint8Array: Uint8Array;
        try {
            uint8Array = await vscode.workspace.fs.readFile(targetUri);
        } catch (e: any) {
            return `[Error: File not found or cannot be read at ${absolutePath}. Check the path and try again.]`;
        }
        const content = new TextDecoder().decode(uint8Array);
        const lines = content.split('\n');
        const safeStartLine = Math.max(1, startLine || 1);
        const safeEndLine = Math.min(lines.length, endLine || safeStartLine);
        return lines
            .slice(safeStartLine - 1, safeEndLine)
            .map((line, index) => `${safeStartLine + index}: ${line}`)
            .join('\n');
    }

    static async searchWorkspaceRegex(pattern: string, relativePath?: string): Promise<string> {
        const files = relativePath
            ? [vscode.Uri.file(path.isAbsolute(relativePath) ? relativePath : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', relativePath))]
            : await vscode.workspace.findFiles('**/*', '**/node_modules/**');
        let matches: string[] = [];
        
        // Validate and sanitize the pattern - only allow simple text search
        let regex: RegExp;
        try {
            // If pattern contains regex special chars or backslashes, treat it as literal text
            if (/[\\$^*+?\[\](){}|]/.test(pattern)) {
                // Escape special regex characters and treat as literal
                const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(escapedPattern, 'i');
            } else {
                regex = new RegExp(pattern, 'i');
            }
        } catch (e: any) {
            return `Invalid search pattern: ${e.message}. Use simple text like 'server', 'url', 'localhost', or 'http'.`;
        }
        
        for (const file of files) {
            try {
                const uint8Array = await vscode.workspace.fs.readFile(file);
                const content = new TextDecoder().decode(uint8Array);
                const lines = content.split('\n');
                const relativePath = vscode.workspace.asRelativePath(file);
                for (let index = 0; index < lines.length; index++) {
                    if (regex.test(lines[index])) {
                        matches.push(`${relativePath}:${index + 1}: ${lines[index].trim()}`);
                        if (matches.length >= 50) {
                            return matches.join('\n');
                        }
                    }
                }
            } catch (e) {}
        }
        return matches.length > 0 ? matches.join('\n') : "No matches found.";
    }

    static async readFullFile(workspacePath: string, relativePath: string): Promise<string> {
        const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(workspacePath, relativePath);
        const targetUri = vscode.Uri.file(absolutePath);
        let uint8Array: Uint8Array;
        try {
            uint8Array = await vscode.workspace.fs.readFile(targetUri);
        } catch (e: any) {
            return `[Error: File not found or cannot be read at ${absolutePath}. Check the path and try again.]`;
        }
        const content = new TextDecoder().decode(uint8Array);
        const lines = content.split('\n');

        // Auto-redirect large files (>400 lines) to analyze_large_file
        if (lines.length > 400) {
            return `[STOP: This file has ${lines.length} lines — too large for read_full_file. Use analyze_large_file on "${relativePath}" to get the semantic index, then use deep_dive_symbol to read specific parts.]`;
        }

        const result = lines
            .map((line, index) => `${index + 1}: ${line}`)
            .join('\n');
        return result;
    }

    static async applyEditDiff(workspacePath: string, relativePath: string, searchBlock: string, replaceBlock: string): Promise<boolean | string> {
        const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(workspacePath, relativePath);
        const targetUri = vscode.Uri.file(absolutePath);
        const document = await vscode.workspace.openTextDocument(targetUri);
        const fileContent = document.getText();

        // Validate that the provided searchBlock includes at least 3 lines
        const searchLines = searchBlock.split('\n');
        // Count non-empty lines as context (but keep empty lines as valid context too)
        if (searchLines.length < 3) {
            return "Validation Failed: You must provide at least 3 lines of surrounding context in the search_block to ensure a unique match. Please try again.";
        }

        if (!fileContent.includes(searchBlock)) {
            return false;
        }

        const idx = fileContent.indexOf(searchBlock);
        const startPos = document.positionAt(idx);
        const endPos = document.positionAt(idx + searchBlock.length);
        const range = new vscode.Range(startPos, endPos);

        const edit = new vscode.WorkspaceEdit();
        edit.replace(targetUri, range, replaceBlock);
        return await vscode.workspace.applyEdit(edit);
    }

}
