import * as vscode from 'vscode';
import * as path from 'path';
import { ChatRequest, ToolResponse, AIResponse, ChatMessage } from '../types/schemas';
import { ModelFactory } from '../models/ModelFactory';
import { ContextEngine } from './ContextEngine';
import { FileSystemTools } from '../tools/FileSystem';
import { LspIntelligence } from '../tools/LspIntelligence';
import { TerminalTools } from '../tools/Terminal';
import { Router } from './Router';
import { Critic } from './Critic';
import { PromptSanitizer } from '../tools/Security';

export interface IAgentUI {
    addStep(icon: string, action: string, target: string): void;
    setLoading(text: string): void;
    removeLoading(): void;
    askApproval(target: string, oldText: string, newText: string): Promise<boolean>;
    statusUpdate?(text: string): void;
}

export class AgentExecutor {
    private chatHistory: ChatMessage[] = [];
    private toolHistory: ToolResponse[] = [];
    private consecutiveToolCalls = 0;
    private MAX_CONSECUTIVE_TOOLS = 15;
    private SELF_HEAL_MAX_ATTEMPTS = 2;
    private selfHealAttempts = 0;

    constructor(
        private ui: IAgentUI,
        private workspacePath: string
    ) {}

    // Debug helpers: expose readonly snapshots for UI tooling
    getChatHistorySnapshot(): ChatMessage[] {
        return JSON.parse(JSON.stringify(this.chatHistory));
    }

    getToolHistorySnapshot(): ToolResponse[] {
        return JSON.parse(JSON.stringify(this.toolHistory));
    }

    async execute(prompt: string, model: string, history: ChatMessage[], settings?: any): Promise<string> {
        this.chatHistory = [...history];
        this.toolHistory = [];
        this.consecutiveToolCalls = 0;

        // Phase 1: Security pre-check and Intent Routing (L0)
        this.ui.setLoading("Running security checks...");
        const sanitize = PromptSanitizer.check(prompt);
        if (sanitize.blocked) {
            this.ui.removeLoading();
            this.ui.addStep('⛔', 'Blocked', sanitize.matches.join(', '));
            return `Security blocked: prompt matched forbidden patterns: ${sanitize.matches.join(', ')}`;
        }

        this.ui.setLoading("Classifying intent...");
        this.ui.statusUpdate?.('Routing intent (L0)...');
        const intent = await Router.classify(prompt, this.chatHistory);
        this.ui.addStep('🧠', 'Routing', intent === 'code_edit' ? 'Work Path (Code Edit)' : 'Chat Path');

        let finalResponse: string = '';

        if (intent === 'chat') {
            finalResponse = await this.runChatFlow(prompt, model);
        } else {
            // Phase 2: Planning & Critic Loop (L2)
            const l2Model = settings?.l2Model || model;
            this.ui.setLoading("Architecting plan...");
            this.ui.statusUpdate?.('Architecting plan (L2)...');
            let plan = await this.generatePlan(prompt, l2Model);
            this.ui.addStep('📝', 'Planning', 'Drafting implementation steps');

            this.ui.setLoading("Reviewing plan...");
            this.ui.statusUpdate?.('Reviewing plan (L2 Critic)...');
            const review = await Critic.reviewPlan(prompt, plan, this.chatHistory, l2Model);
            if (!review.approved) {
                this.ui.addStep('⚠️', 'Critic Review', 'Correction suggested');
                this.ui.setLoading("Refining plan...");
                plan = await this.refinePlan(prompt, plan, review.feedback || '', l2Model);
                this.ui.addStep('🔄', 'Planning', 'Plan refined based on Critic feedback');
            } else {
                this.ui.addStep('✅', 'Critic Review', 'Plan approved by Senior Architect');
            }

            // Phase 3 & 4: Surgical Execution & Self-Healing
            finalResponse = await this.runExecutionFlow(prompt, plan, model);
        }

        // Phase 5: Memory pruning — let L2 Critic compress long histories
        try {
            const TOOL_THRESHOLD = 5;
            const CHAT_THRESHOLD = 10;
            if (this.toolHistory.length > TOOL_THRESHOLD || this.chatHistory.length > CHAT_THRESHOLD) {
                const l2Model = settings?.l2Model || model;
                this.ui.setLoading('L2 Critic is compressing session memory...');
                this.ui.addStep('🗜️', 'Compressing', 'L2 Critic');

                const summary = await Critic.compressSession(this.chatHistory, this.toolHistory, l2Model);

                // Keep the last user message to preserve immediate context
                const lastUser = [...this.chatHistory].reverse().find(m => m.role === 'user');

                // Wipe histories and inject compressed system memory
                this.toolHistory = [];
                this.chatHistory = [];
                this.chatHistory.push({ role: 'system', text: summary });
                if (lastUser) this.chatHistory.push(lastUser);

                this.ui.removeLoading();
                this.ui.addStep('✅', 'Compressed', 'Session memory compressed');
            }
        } catch (e) {
            console.error('[Lattice] Memory pruning failed:', e);
        }

        return finalResponse;
    }

    private async runChatFlow(prompt: string, model: string): Promise<string> {
        const systemInstruction = `You are Lattice, an expert AI assistant. Answer the user's question clearly and concisely.`;
        const request = {
            prompt,
            model,
            workspace: this.workspacePath,
            tool_history: [],
            chat_history: this.chatHistory
        };
        const response = await ModelFactory.generateWithFallback(request, systemInstruction);
        return response.type === 'message' ? response.content : "Error in chat flow.";
    }

    private async generatePlan(prompt: string, model: string): Promise<string> {
        const systemInstruction = "Create a detailed step-by-step plan to implement the user's request. Do not call tools yet. Be specific about which files will be modified.";
        const request = { prompt, model, workspace: this.workspacePath, tool_history: [], chat_history: this.chatHistory };
        const response = await ModelFactory.generateWithFallback(request, systemInstruction);
        return response.type === 'message' ? response.content : "Failed to generate plan.";
    }

    private async refinePlan(prompt: string, oldPlan: string, feedback: string, model: string): Promise<string> {
        const promptText = `Original Request: ${prompt}\n\nDraft Plan: ${oldPlan}\n\nArchitect Feedback: ${feedback}\n\nPlease provide a refined, corrected plan.`;
        return this.generatePlan(promptText, model);
    }

    private async runExecutionFlow(prompt: string, plan: string, model: string): Promise<string> {
        let isDone = false;
        let currentPrompt = `Execute this plan: ${plan}\n\nOriginal Request: ${prompt}`;

        while (!isDone) {
            let request: ChatRequest = {
                prompt: currentPrompt,
                model: model,
                workspace: this.workspacePath,
                tool_history: this.toolHistory,
                chat_history: this.chatHistory
            };

            request = ContextEngine.pruneContext(request);
            const passiveContext = await ContextEngine.getPassiveContext();
            const systemInstruction = `You are Lattice. Execute the implementation plan surgically. ${passiveContext}`;

            this.ui.setLoading("Thinking...");
            const data: AIResponse = await ModelFactory.generateWithFallback(request, systemInstruction);

            if (data.type === 'tool_call') {
                const toolName = data.tool_name;
                const toolArgs = data.arguments;
                const targetPath = toolArgs.relative_path || '';
                let toolResultContent = '';

                this.ui.removeLoading();
                this.updateUIStep(toolName, targetPath, toolArgs.query || toolArgs.pattern);
                this.ui.setLoading(`Executing ${toolName}...`);

                try {
                    if (toolName === 'read_file_chunk') {
                        toolResultContent = await FileSystemTools.readFileChunk(this.workspacePath, targetPath, toolArgs.start_line, toolArgs.end_line);
                    } else if (toolName === 'list_directory_tree') {
                        toolResultContent = await FileSystemTools.listDirectoryTree(this.workspacePath, targetPath, toolArgs.depth);
                    } else if (toolName === 'search_workspace_regex') {
                        toolResultContent = await FileSystemTools.searchWorkspaceRegex(toolArgs.pattern);
                    } else if (toolName === 'edit_file_diff') {
                        const approved = await this.ui.askApproval(targetPath, toolArgs.search_block, toolArgs.replace_block);
                        if (approved) {
                            const editResult = await FileSystemTools.applyEditDiff(this.workspacePath, targetPath, toolArgs.search_block, toolArgs.replace_block);
                            if (typeof editResult === 'string') {
                                // Validation or other string error returned from the tool
                                toolResultContent = editResult;
                            } else if (editResult === true) {
                                toolResultContent = `Successfully edited ${targetPath}.`;
                                // Phase 4: Self-Healing (Compiler Loop)
                                const diagnostics = await LspIntelligence.getWorkspaceDiagnostics();
                                if (diagnostics !== "No active diagnostics found. Workspace is clean.") {
                                    this.ui.addStep('💊', 'Self-Healing', 'Checking diagnostics');
                                    toolResultContent += `\n\nCRITICAL: Workspace has errors/warnings after edit:\n${diagnostics}\n\nPlease fix these errors immediately.`;
                                }
                            } else {
                                toolResultContent = `Error: The exact search_block was not found in ${targetPath}. Check whitespace and indentation.`;
                            }
                        } else {
                            toolResultContent = `CRITICAL ALERT: The user REJECTED this edit. Stop this path and ask for instructions.`;
                        }
                    } else if (toolName === 'get_workspace_diagnostics') {
                        toolResultContent = await LspIntelligence.getWorkspaceDiagnostics();
                    } else if (toolName === 'execute_command') {
                        toolResultContent = await TerminalTools.executeCommand(toolArgs.command);
                    }
                } catch (err: any) {
                    toolResultContent = `Error executing ${toolName}: ${err.message}`;
                }

                this.toolHistory.push({ tool_name: toolName, content: toolResultContent, arguments: toolArgs });
                this.consecutiveToolCalls++;
                if (this.consecutiveToolCalls > this.MAX_CONSECUTIVE_TOOLS) {
                    return "Maximum tool calls exceeded. Stopping to prevent loop.";
                }
            } else {
                return data.content;
            }
        }
        return "Implementation completed.";
    }

    private updateUIStep(toolName: string, targetPath: string, extra?: any) {
        let icon = '📂'; let action = 'Scanning';
        if (toolName === 'read_file_chunk') { icon = '📄'; action = 'Reading'; }
        else if (toolName === 'edit_file_diff') { icon = '✏️'; action = 'Editing'; }
        else if (toolName === 'search_workspace_regex') { icon = '🔍'; action = 'Searching'; targetPath = String(extra); }
        else if (toolName === 'get_workspace_diagnostics') { icon = '💊'; action = 'Diagnostics'; targetPath = 'Workspace'; }
        else if (toolName === 'execute_command') { icon = '💻'; action = 'Terminal'; targetPath = String(extra); }
        this.ui.addStep(icon, action, targetPath);
        this.ui.statusUpdate?.(`${action}: ${targetPath}`);
    }
}
