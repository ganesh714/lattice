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
        return lines.slice(startLine - 1, endLine).join('\n');
    }

    static async searchWorkspaceRegex(pattern: string): Promise<string> {
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
        let matches: string[] = [];
        const regex = new RegExp(pattern, 'i');
        
        for (const file of files) {
            try {
                const uint8Array = await vscode.workspace.fs.readFile(file);
                const content = new TextDecoder().decode(uint8Array);
                if (regex.test(content)) {
                    matches.push(vscode.workspace.asRelativePath(file));
                }
            } catch (e) {}
            if (matches.length > 20) break;
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
