import * as vscode from 'vscode';
import { ChatRequest } from '../types/schemas';

export class ContextEngine {
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
        
        // 1. Truncate individual tool results to a sane limit (~2.5k tokens)
        const MAX_TOOL_CHARS = 10000; 
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

        return newRequest;
    }

    /**
     * Assembles the "Passive Context" (active viewport, .latticerules, etc.)
     */
    static async getPassiveContext(): Promise<string> {
        // In the future, this will parse .latticerules and recent file trajectory.
        // For now, it provides basic workspace context.
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'Unknown';
        return `Current Workspace: ${workspacePath}\nRules: Please follow SOLID principles and maintain consistent indentation.`;
    }
}
