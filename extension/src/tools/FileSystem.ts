import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';

export class FileSystemTools {
    static async listDirectoryTree(workspacePath: string, relativePath: string, depth: number = 2): Promise<string> {
        const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(workspacePath, relativePath);
        const targetUri = vscode.Uri.file(absolutePath);
        
        async function scan(uri: vscode.Uri, currentDepth: number): Promise<any> {
            if (currentDepth > depth) return "...";
            try {
                const entries = await vscode.workspace.fs.readDirectory(uri);
                const result: any = {};
                for (const [name, type] of entries) {
                    if (type === vscode.FileType.Directory) {
                        result[name] = await scan(vscode.Uri.joinPath(uri, name), currentDepth + 1);
                    } else {
                        result[name] = "file";
                    }
                }
                return result;
            } catch (e) {
                return "[Error reading directory]";
            }
        }

        const tree = await scan(targetUri, 0);
        return JSON.stringify(tree, null, 2);
    }

    static async readFileChunk(workspacePath: string, relativePath: string, startLine: number, endLine: number): Promise<string> {
        const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(workspacePath, relativePath);
        const targetUri = vscode.Uri.file(absolutePath);
        const uint8Array = await vscode.workspace.fs.readFile(targetUri);
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
