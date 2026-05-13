import * as vscode from 'vscode';
import * as path from 'path';
import { ChatRequest, ToolResponse, AIResponse, ChatMessage } from '../types/schemas';
import { ModelFactory } from '../models/ModelFactory';
import { ContextEngine } from './ContextEngine';
import { FileSystemTools } from '../tools/FileSystem';

export interface IAgentUI {
    addStep(icon: string, action: string, target: string): void;
    setLoading(text: string): void;
    removeLoading(): void;
    askApproval(target: string, oldText: string, newText: string): Promise<boolean>;
}

export class AgentExecutor {
    private chatHistory: ChatMessage[] = [];
    private toolHistory: ToolResponse[] = [];
    private consecutiveToolCalls = 0;
    private MAX_CONSECUTIVE_TOOLS = 15;

    constructor(
        private ui: IAgentUI,
        private workspacePath: string
    ) {}

    async execute(prompt: string, model: string, history: ChatMessage[]): Promise<string> {
        this.chatHistory = [...history];
        this.toolHistory = [];
        this.consecutiveToolCalls = 0;

        let isDone = false;
        let finalResponseText = "No response field returned.";
        let currentPrompt = prompt;

        while (!isDone) {
            // 1. Prepare Request
            let request: ChatRequest = {
                prompt: currentPrompt,
                model: model,
                workspace: this.workspacePath,
                tool_history: this.toolHistory,
                chat_history: this.chatHistory
            };

            // 2. Prune Context
            request = ContextEngine.pruneContext(request);

            // 3. Gather Passive Context
            const passiveContext = await ContextEngine.getPassiveContext();
            const systemInstruction = `You are Lattice, an expert AI coding assistant. ${passiveContext}`;

            // 4. Generate AI Response
            this.ui.setLoading("Thinking...");
            const data: AIResponse = await ModelFactory.generateWithFallback(request, systemInstruction);

            if (data.type === 'tool_call') {
                const toolName = data.tool_name;
                const toolArgs = data.arguments;
                const targetPath = toolArgs.relative_path || '';
                let toolResultContent = '';

                this.ui.removeLoading();
                this.updateUIStep(toolName, targetPath, toolArgs.query);
                this.ui.setLoading(`Executing ${toolName}...`);

                try {
                    if (toolName === 'read_file') {
                        toolResultContent = await FileSystemTools.readFile(this.workspacePath, targetPath);
                    } else if (toolName === 'list_directory') {
                        toolResultContent = await FileSystemTools.listDirectory(this.workspacePath, targetPath);
                    } else if (toolName === 'search_in_files') {
                        toolResultContent = await FileSystemTools.searchInFiles(this.workspacePath, toolArgs.query);
                    } else if (toolName === 'modify_file') {
                        const approved = await this.ui.askApproval(targetPath, toolArgs.old_text, toolArgs.new_text);
                        if (approved) {
                            const success = await FileSystemTools.applyEdit(this.workspacePath, targetPath, toolArgs.old_text, toolArgs.new_text);
                            toolResultContent = success 
                                ? `Successfully applied edit to ${targetPath}.` 
                                : `Error: Exact old_text not found in ${targetPath}.`;
                        } else {
                            toolResultContent = `CRITICAL: User rejected the edit to ${targetPath}. Stop and ask for clarification.`;
                        }
                    }
                } catch (err: any) {
                    toolResultContent = `Error: ${err.message}`;
                }

                this.toolHistory.push({
                    tool_name: toolName,
                    content: toolResultContent,
                    arguments: toolArgs
                });

                this.consecutiveToolCalls++;
                if (this.consecutiveToolCalls > this.MAX_CONSECUTIVE_TOOLS) {
                    finalResponseText = "Maximum tool calls exceeded.";
                    isDone = true;
                }
            } else {
                finalResponseText = data.content;
                isDone = true;
            }
        }

        return finalResponseText;
    }

    private updateUIStep(toolName: string, targetPath: string, query?: string) {
        let icon = '📂';
        let action = 'Scanning';
        if (toolName === 'read_file') { icon = '📄'; action = 'Reading'; }
        else if (toolName === 'modify_file') { icon = '✏️'; action = 'Editing'; }
        else if (toolName === 'search_in_files') { icon = '🔍'; action = 'Searching'; targetPath = query || ''; }
        
        this.ui.addStep(icon, action, targetPath);
    }
}
