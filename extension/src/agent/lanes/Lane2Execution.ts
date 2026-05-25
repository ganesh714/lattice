import * as vscode from 'vscode';
import { ILaneStrategy } from './ILaneStrategy';
import { ChatMessage, ChatRequest, ToolResponse, AIResponse } from '../../types/schemas';
import { ContextEngine } from '../ContextEngine';
import { ModelFactory } from '../../models/ModelFactory';
import { FileSystemTools } from '../../tools/FileSystem';
import { IAgentUI } from '../AgentExecutor';
import { Critic } from '../Critic';
import { LspIntelligence } from '../../tools/LspIntelligence';
import { TerminalTools } from '../../tools/Terminal';
import { McpClient } from '../../tools/McpClient';

export class Lane2Execution implements ILaneStrategy {
    private MAX_CONSECUTIVE_TOOLS = 15;

    constructor(
        private ui: IAgentUI,
        private workspacePath: string
    ) {}

    async execute(prompt: string, model: string, history: ChatMessage[], settings?: any): Promise<string> {
        const l2Model = settings?.l2Model || model;
        
        // Phase 2: Planning & Critic Loop
        const plan = await this.createReviewedPlan(prompt, history, model, l2Model);

        // Phase 3 & 4: Surgical Execution & Self-Healing
        return await this.runExecutionFlow(prompt, plan, model, history, []);
    }

    private async generatePlan(prompt: string, model: string, history: ChatMessage[]): Promise<string> {
        const passiveContext = await ContextEngine.getPassiveContext(false);
        const systemInstruction = `Create a detailed step-by-step plan to implement the user's request. Do not call tools yet. Be specific about which files will be modified. ${passiveContext}`;
        const request = { prompt, model, workspace: this.workspacePath, tool_history: [], chat_history: history };
        const response = await ModelFactory.generateWithFallback(request, systemInstruction);
        return response.type === 'message' ? response.content : "Failed to generate plan.";
    }

    public async createReviewedPlan(prompt: string, history: ChatMessage[], planModel: string, criticModel: string): Promise<string> {
        this.ui.setLoading("Architecting plan...");
        this.ui.statusUpdate?.('Architecting plan...');
        let plan = await this.generatePlan(prompt, planModel, history);
        this.ui.addStep('📝', 'Planning', 'Drafting implementation steps');

        if (this.ui.addMessage) {
            this.ui.addMessage("### Drafted Implementation Plan\n\n" + plan, false);
        }

        this.ui.setLoading("Reviewing plan...");
        this.ui.statusUpdate?.('Reviewing plan (L2 Critic)...');
        const review = await Critic.reviewPlan(prompt, plan, history, criticModel);
        
        if (!review.approved) {
            this.ui.addStep('⚠️', 'Critic Review', 'Correction suggested');
            this.ui.setLoading("Refining plan...");
            plan = await this.refinePlan(prompt, plan, review.feedback || '', planModel, history);
            this.ui.addStep('🔄', 'Planning', 'Plan refined based on Critic feedback');
            
            this.ui.setLoading("Rechecking refined plan...");
            const refinedReview = await Critic.reviewPlan(prompt, plan, history, criticModel);
            if (!refinedReview.approved) {
                this.ui.addStep('⛔', 'Critic Review', 'Plan not approved');
                throw new Error(`L2 Critic could not approve the plan: ${refinedReview.feedback || 'No feedback provided.'}`);
            }
            this.ui.addStep('✅', 'Critic Review', 'Refined plan approved by Senior Architect');
        } else {
            this.ui.addStep('✅', 'Critic Review', 'Plan approved by Senior Architect');
        }

        return plan;
    }

    private async refinePlan(prompt: string, oldPlan: string, feedback: string, model: string, history: ChatMessage[]): Promise<string> {
        const promptText = `Original Request: ${prompt}\n\nDraft Plan: ${oldPlan}\n\nArchitect Feedback: ${feedback}\n\nPlease provide a refined, corrected plan.`;
        return this.generatePlan(promptText, model, history);
    }

    public async runExecutionFlow(prompt: string, plan: string, model: string, history: ChatMessage[], existingToolHistory: ToolResponse[] = []): Promise<string> {
        let isDone = false;
        let currentPrompt = `Execute this plan: ${plan}\n\nOriginal Request: ${prompt}`;
        let consecutiveToolCalls = 0;

        while (!isDone) {
            let request: ChatRequest = {
                prompt: currentPrompt,
                model: model,
                workspace: this.workspacePath,
                tool_history: existingToolHistory,
                chat_history: history
            };

            request = ContextEngine.pruneContext(request);
            const passiveContext = await ContextEngine.getPassiveContext(true);
            const systemInstruction = `You are Lattice. Execute the implementation plan surgically.

You only have partial visibility into the user's active file to save memory. If you need to understand the full structure or find specific variables, you MUST use the search_workspace_regex or read_file_chunk tools before attempting an edit.

For information requests, answer directly when the visible active-file context contains the answer. If you need tools for an information request, prefer read_file_chunk for the active file. 

WHEN USING search_workspace_regex:
- ONLY use simple, plain-text patterns: "server", "url", "localhost", "http", "port", "endpoint"
- NEVER use regex escape sequences, backslashes, or complex patterns
- NEVER use patterns like: "server\\s*:", "url.*http", or any regex with \\, $, ^, *, +, ?, [, ]
- If you need to search for special characters, ask the user first
- search_workspace_regex returns matching file paths, line numbers, and line snippets. If a search result directly answers an information request, answer from that result instead of continuing to search.
- When you have the answer, respond as normal plain text. Do not call tools named print, final, answer, or respond.

${passiveContext}`;

            this.ui.setLoading("Thinking...");
            let data: AIResponse = await ModelFactory.generateWithFallback(request, systemInstruction);
            if (data.type === 'message') {
                data = this.tryParseInlineToolCall(data.content) || data;
            }

            if (data.type === 'tool_call') {
                const toolName = data.tool_name;
                const toolArgs = data.arguments;
                const targetPath = toolArgs.relative_path || '';
                let toolResultContent = '';

                this.ui.removeLoading();
                this.updateUIStep(toolName, targetPath, toolArgs.query || toolArgs.pattern);
                this.ui.setLoading(`Executing ${toolName}...`);

                console.log(`[Lattice AgentExecutor] [Lane 2] Executing tool "${toolName}" with arguments:`, JSON.stringify(toolArgs, null, 2));

                try {
                    if (toolName === 'read_file_chunk') {
                        toolResultContent = await FileSystemTools.readFileChunk(this.workspacePath, targetPath, toolArgs.start_line, toolArgs.end_line);
                    } else if (toolName === 'list_directory_tree') {
                        toolResultContent = await FileSystemTools.listDirectoryTree(this.workspacePath, targetPath, toolArgs.depth);
                    } else if (toolName === 'search_workspace_regex') {
                        const searchPath = this.needsActiveFileContext(prompt)
                            ? (toolArgs.relative_path || this.getActiveFileRelativePath())
                            : toolArgs.relative_path;
                        toolResultContent = await FileSystemTools.searchWorkspaceRegex(toolArgs.pattern, searchPath);
                    } else if (toolName === 'edit_file_diff') {
                        const approved = await this.ui.askApproval(targetPath, toolArgs.search_block, toolArgs.replace_block);
                        if (approved) {
                            const editResult = await FileSystemTools.applyEditDiff(this.workspacePath, targetPath, toolArgs.search_block, toolArgs.replace_block);
                            if (typeof editResult === 'string') {
                                toolResultContent = editResult;
                            } else if (editResult === true) {
                                toolResultContent = `Successfully edited ${targetPath}.`;
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
                    } else if (McpClient.isMcpTool(toolName)) {
                        toolResultContent = await McpClient.executeMcpTool(toolName, toolArgs);
                    } else {
                        throw new Error(`Unknown tool: ${toolName}`);
                    }
                } catch (err: any) {
                    toolResultContent = `Error executing ${toolName}: ${err.message}`;
                }

                console.log(`[Lattice AgentExecutor] [Lane 2] Tool "${toolName}" returned:`, toolResultContent);

                existingToolHistory.push({ tool_name: toolName, content: toolResultContent, arguments: toolArgs });
                consecutiveToolCalls++;
                if (consecutiveToolCalls > this.MAX_CONSECUTIVE_TOOLS) {
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
        else if (McpClient.isMcpTool(toolName)) { icon = '🔌'; action = 'MCP Tool'; targetPath = toolName; }
        this.ui.addStep(icon, action, targetPath);
        this.ui.statusUpdate?.(`${action}: ${targetPath}`);
    }

    private needsActiveFileContext(prompt: string): boolean {
        const normalized = prompt.toLowerCase();
        const referencesActiveFile =
            /\b(this|current|active|opened|open)\s+file\b/.test(normalized) ||
            /\bin\s+this\s+file\b/.test(normalized) ||
            /\b(this|current|active|opened|open)\s+(html|css|js|ts|tsx|jsx|py|java|go|rs|php|json|yaml|yml|xml|md)\b/.test(normalized);
        const referencesHere = /\b(here|this|current|above|below)\b/.test(normalized);
        const asksForInspection = /\b(what|where|which|show|find|read|explain|summarize|server\s+url|url|endpoint|port|api|localhost|host|base\s+url|fetch|axios|variable|function|class|const|let)\b/.test(normalized);
        const asksCodeFact = /\b(server\s+url|url|endpoint|port|api|localhost|host|base\s+url|fetch|axios|variable|function|class|const|let)\b/.test(normalized);
        return (referencesActiveFile && asksForInspection) || (referencesHere && asksCodeFact);
    }

    private getActiveFileRelativePath(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        return editor ? vscode.workspace.asRelativePath(editor.document.uri) : undefined;
    }

    private tryParseInlineToolCall(content: string): AIResponse | null {
        const matches = content.match(/\{[^{}]*(?:"pattern"|"relative_path")[^{}]*\}/g);
        if (!matches) {
            return null;
        }

        for (const match of matches) {
            try {
                const args = JSON.parse(match);
                if (typeof args.pattern === 'string') {
                    return {
                        type: 'tool_call',
                        tool_name: 'search_workspace_regex',
                        arguments: args
                    };
                }

                if (typeof args.relative_path === 'string') {
                    if (typeof args.start_line === 'number' && typeof args.end_line === 'number') {
                        return {
                            type: 'tool_call',
                            tool_name: 'read_file_chunk',
                            arguments: args
                        };
                    }

                    return {
                        type: 'tool_call',
                        tool_name: 'list_directory_tree',
                        arguments: args
                    };
                }
            } catch {
                continue;
            }
        }
        return null;
    }
}
