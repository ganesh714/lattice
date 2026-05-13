import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';

export class FileSystemTools {
    static async listDirectory(workspacePath: string, relativePath: string): Promise<string> {
        const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(workspacePath, relativePath);
        const targetUri = vscode.Uri.file(absolutePath);
        const entries = await vscode.workspace.fs.readDirectory(targetUri);
        return entries
            .map(([name, type]) => type === vscode.FileType.Directory ? `[Folder] ${name}` : `[File] ${name}`)
            .join('\n');
    }

    static async readFile(workspacePath: string, relativePath: string): Promise<string> {
        const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(workspacePath, relativePath);
        const targetUri = vscode.Uri.file(absolutePath);
        const uint8Array = await vscode.workspace.fs.readFile(targetUri);
        return new TextDecoder().decode(uint8Array);
    }

    static async searchInFiles(workspacePath: string, query: string): Promise<string> {
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
        let matches: string[] = [];
        
        for (const file of files) {
            try {
                const uint8Array = await vscode.workspace.fs.readFile(file);
                const content = new TextDecoder().decode(uint8Array);
                if (content.includes(query)) {
                    matches.push(vscode.workspace.asRelativePath(file));
                }
            } catch (e) {
                // Skip files that can't be read (e.g. binaries)
            }
            if (matches.length > 20) break; // Token safety
        }
        return matches.length > 0 ? matches.join('\n') : "No matches found.";
    }

    // Note: modifyFile usually requires UI interaction for approval, 
    // which should be handled by the AgentExecutor calling back to the Provider.
    // This function just performs the low-level edit.
    static async applyEdit(workspacePath: string, relativePath: string, oldText: string, newText: string): Promise<boolean> {
        const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(workspacePath, relativePath);
        const targetUri = vscode.Uri.file(absolutePath);
        const document = await vscode.workspace.openTextDocument(targetUri);
        const fileContent = document.getText();

        if (!fileContent.includes(oldText)) {
            return false;
        }

        const idx = fileContent.indexOf(oldText);
        const startPos = document.positionAt(idx);
        const endPos = document.positionAt(idx + oldText.length);
        const range = new vscode.Range(startPos, endPos);

        const edit = new vscode.WorkspaceEdit();
        edit.replace(targetUri, range, newText);
        return await vscode.workspace.applyEdit(edit);
    }
}
