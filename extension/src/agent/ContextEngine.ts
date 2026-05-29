import * as vscode from 'vscode';
import { ChatRequest } from '../types/schemas';

export class ContextEngine {
    private static readonly SMALL_FILE_LINE_LIMIT = 100;
    private static readonly ACTIVE_FILE_CONTEXT_WINDOW = 20;

    /**
     * Rough estimation of tokens: ~4 chars per token.
     */
    static estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    /**
     * Truncates tool results and drops old chat history to fit within maxTokens.
     */
    static pruneContext(request: ChatRequest, maxTokens: number = 8000): ChatRequest {
        // Deep clone to avoid mutating the original object
        const newRequest = JSON.parse(JSON.stringify(request)) as ChatRequest;
        
        // 1. Truncate individual tool results to a sane limit (~1k tokens)
        const MAX_TOOL_CHARS = 4000; 
        for (const toolRes of newRequest.tool_history) {
            if (toolRes.content.length > MAX_TOOL_CHARS) {
                toolRes.content = toolRes.content.substring(0, MAX_TOOL_CHARS) + 
                    "\n\n[Content truncated by Lattice to save tokens...]";
            }
        }

        const calculateTotal = () => {
            let total = this.estimateTokens(newRequest.prompt);
            total += newRequest.chat_history.reduce((acc, msg) => acc + this.estimateTokens(msg.text), 0);
            total += newRequest.tool_history.reduce((acc, tool) => acc + this.estimateTokens(tool.content), 0);
            return total;
        };

        // 2. Drop oldest chat history if still too large
        // We keep at least the last message if possible
        while (calculateTotal() > maxTokens && newRequest.chat_history.length > 1) {
            newRequest.chat_history.shift();
        }

        // 3. Drop oldest tool history entries if STILL over budget.
        // Keep at least the 2 most recent tool results so the Analyzer/Actor
        // can reference what was just done. Older results are already captured
        // in the discoveries scratchpad.
        while (calculateTotal() > maxTokens && newRequest.tool_history.length > 2) {
            newRequest.tool_history.shift();
        }

        return newRequest;
    }

    /**
     * Assembles the "Passive Context" (active viewport, .latticerules, etc.)
     */
    static async getPassiveContext(includeActiveFileContent: boolean = false): Promise<string> {
        let context = "";
        
        // 1. Project-specific Rules (.latticerules)
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            const rulesUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.latticerules');
            try {
                const uint8Array = await vscode.workspace.fs.readFile(rulesUri);
                const rules = new TextDecoder().decode(uint8Array);
                context += `\n[Project Rules (.latticerules)]:\n${rules}\n`;
            } catch (e) {
                // Rules file doesn't exist or is inaccessible
            }
        }

        // 2. Active Selection Context
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const doc = editor.document;
            const selection = editor.selection;
            const relativePath = vscode.workspace.asRelativePath(doc.uri);
            const totalLines = doc.lineCount;
            
            context += `\n[Active File]: ${relativePath}\n[Active File Total Lines]: ${totalLines}`;
            if (!selection.isEmpty) {
                const selectedText = doc.getText(selection);
                const selectionStart = selection.start.line + 1;
                const selectionEnd = selection.end.line + 1;
                context += `\n[User Selection: lines ${selectionStart}-${selectionEnd}]:\n${selectedText}\n`;
                if (includeActiveFileContent) {
                    if (totalLines <= this.SMALL_FILE_LINE_LIMIT) {
                        context += `\n[Active File Content: full file]:\n${this.getDocumentLines(doc, 0, totalLines - 1)}\n`;
                    } else {
                        const startLine = Math.max(0, selection.start.line - this.ACTIVE_FILE_CONTEXT_WINDOW);
                        const endLine = Math.min(totalLines - 1, selection.end.line + this.ACTIVE_FILE_CONTEXT_WINDOW);
                        context += `\n[Active File Partial Context: lines ${startLine + 1}-${endLine + 1} around selection]:\n${this.getDocumentLines(doc, startLine, endLine)}\n`;
                        context += `[Active File Notice]: Large file detected. Only the selection and nearby context are included.\n`;
                    }
                }
            } else if (includeActiveFileContent) {
                if (totalLines <= this.SMALL_FILE_LINE_LIMIT) {
                    context += `\n[Active File Content: full file]:\n${this.getDocumentLines(doc, 0, totalLines - 1)}\n`;
                } else {
                    const cursorLine = selection.active.line;
                    const startLine = Math.max(0, cursorLine - this.ACTIVE_FILE_CONTEXT_WINDOW);
                    const endLine = Math.min(totalLines - 1, cursorLine + this.ACTIVE_FILE_CONTEXT_WINDOW);
                    context += `\n[Active File Partial Context: lines ${startLine + 1}-${endLine + 1} around cursor line ${cursorLine + 1}]:\n${this.getDocumentLines(doc, startLine, endLine)}\n`;
                    context += `[Active File Notice]: Large file detected. Only partial active-file context is included.\n`;
                }
            }
        }

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'Unknown';
        return `Current Workspace: ${workspacePath}${context}\n\nGeneral Instruction: Please follow SOLID principles and maintain consistent indentation.`;
    }

    private static getDocumentLines(doc: vscode.TextDocument, startLine: number, endLine: number): string {
        const lines: string[] = [];
        for (let line = startLine; line <= endLine; line++) {
            lines.push(`${line + 1}: ${doc.lineAt(line).text}`);
        }
        return lines.join('\n');
    }
}
