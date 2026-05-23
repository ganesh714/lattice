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
import { McpClient } from '../tools/McpClient';

type ExecutionIntent = 'chat' | 'code_edit' | 'LANE_3';

export interface IAgentUI {
    addStep(icon: string, action: string, target: string): void;
    setLoading(text: string): void;
    removeLoading(): void;
    askApproval(target: string, oldText: string, newText: string): Promise<boolean>;
    askPlanApproval(plan: string): Promise<boolean>;
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
        const needsActiveFileContext = this.needsActiveFileContext(prompt);
        let intent: ExecutionIntent;
        if (sanitize.blocked) {
            intent = 'LANE_3';
            this.ui.addStep('⚠️', 'Risk Check', `Lane 3: ${sanitize.matches.join(', ')}`);
            this.ui.statusUpdate?.('Dangerous prompt detected; routing to Lane 3...');
        } else {
            this.ui.setLoading("Classifying intent...");
            this.ui.statusUpdate?.('Routing intent (L0)...');
            intent = await Router.classify(prompt, this.chatHistory);
            this.ui.addStep('🧠', 'Routing', intent === 'code_edit' ? 'Work Path (Code Edit)' : 'Chat Path');
        }

        let finalResponse: string = '';

        if (intent === 'chat') {
            finalResponse = await this.runChatFlow(prompt, model);
        } else if (intent === 'code_edit' && needsActiveFileContext) {
            finalResponse = await this.runActiveFileEvidenceFlow(prompt, model);
        } else {
            // Phase 2: Planning & Critic Loop
            const l2Model = settings?.l2Model || model;
            const planModel = intent === 'LANE_3' ? model : l2Model;
            const plan = await this.createReviewedPlan(prompt, planModel, l2Model);

            if (intent === 'LANE_3') {
                this.ui.removeLoading();
                this.ui.addStep('⏸️', 'Approval', 'Waiting for plan approval');
                const approved = await this.ui.askPlanApproval(plan);
                if (!approved) {
                    this.ui.addStep('❌', 'Approval', 'Plan rejected');
                    return "Plan rejected. Modify the request or send revised instructions, and I will draft a safer plan.";
                }
                this.ui.addStep('✅', 'Approval', 'Plan approved');
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

    private createActiveFileAnswerPlan(prompt: string): string {
        return `Answer the user's question about the active file.

Original Request: ${prompt}

Rules:
- This is an information request about the active file, not an edit request.
- First inspect the visible active-file context in the system prompt.
- If the answer is visible there, answer directly.
- If the answer is not visible there, use read_file_chunk on the active file path from the system prompt to inspect likely sections.
- If you need to locate a symbol or URL, use simple search_workspace_regex patterns such as "server", "url", "localhost", "http", "endpoint", "port", "fetch", or "axios".
- search_workspace_regex returns matching file paths, line numbers, and line snippets. If a search result directly answers the question, answer from that result instead of continuing to search.
- When you have the answer, respond as normal plain text. Do not call tools named print, final, answer, or respond.
- Do not edit files.`;
    }

    private async runActiveFileEvidenceFlow(prompt: string, model: string): Promise<string> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            const plan = this.createActiveFileAnswerPlan(prompt);
            return await this.runExecutionFlow(prompt, plan, model);
        }

        const activePath = vscode.workspace.asRelativePath(editor.document.uri);
        const passiveContext = await ContextEngine.getPassiveContext(true);
        const evidence = await this.collectActiveFileEvidence(prompt, activePath);

        this.ui.addStep('🔎', 'Evidence', activePath);
        this.ui.statusUpdate?.('Gathered active-file evidence');

        const systemInstruction = `You are Lattice. Answer active-file questions using only the provided active-file context and evidence.

Rules:
- Do not call tools.
- Do not invent values that are not present in the evidence or active-file context.
- If the answer is present, answer concisely and include the source line number when available.
- If the evidence is insufficient, say exactly what could not be found in the active file.`;

        const evidenceText = evidence || "No direct search evidence was found in the active file.";
        const request: ChatRequest = {
            prompt: `Original request: ${prompt}

Active file: ${activePath}

Evidence from active file:
${evidenceText}

${passiveContext}`,
            model,
            workspace: this.workspacePath,
            tool_history: [],
            chat_history: this.chatHistory,
            disableTools: true
        };

        const response = await ModelFactory.generateWithFallback(ContextEngine.pruneContext(request, 5000), systemInstruction);
        return response.type === 'message' ? response.content : "I could not answer from the active-file evidence.";
    }

    private async collectActiveFileEvidence(prompt: string, activePath: string): Promise<string> {
        const terms = this.deriveEvidenceSearchTerms(prompt);
        const evidenceLines: string[] = [];
        const seen = new Set<string>();

        for (const term of terms) {
            const result = await FileSystemTools.searchWorkspaceRegex(term, activePath);
            if (result === "No matches found." || result.startsWith("Invalid search pattern:")) {
                continue;
            }

            for (const line of result.split('\n')) {
                if (!seen.has(line)) {
                    seen.add(line);
                    evidenceLines.push(line);
                }
                if (evidenceLines.length >= 80) {
                    return evidenceLines.join('\n');
                }
            }
        }

        return evidenceLines.join('\n');
    }

    private deriveEvidenceSearchTerms(prompt: string): string[] {
        const normalized = prompt.toLowerCase();
        const stopWords = new Set([
            'what', 'where', 'which', 'when', 'why', 'how', 'this', 'that', 'here', 'file',
            'current', 'active', 'opened', 'open', 'please', 'tell', 'show', 'find', 'read',
            'explain', 'summarize', 'required', 'need', 'needs', 'run', 'using', 'with', 'from',
            'into', 'for', 'the', 'and', 'or', 'but', 'can', 'you', 'iis', 'is', 'are', 'to'
        ]);

        const terms: string[] = [];
        for (const token of normalized.match(/[a-zA-Z_][a-zA-Z0-9_-]{2,}/g) || []) {
            if (!stopWords.has(token)) {
                terms.push(token);
            }
        }

        const connectionQuestion = /\b(url|uri|endpoint|api|server|backend|frontend|host|localhost|port|connect|fetch|request)\b/.test(normalized);
        if (connectionQuestion) {
            terms.push('http', 'localhost', 'fetch', 'axios', 'url', 'api', 'server', 'endpoint', 'port');
        }

        return [...new Set(terms)].slice(0, 12);
    }

    private async runChatFlow(prompt: string, model: string): Promise<string> {
        const passiveContext = await ContextEngine.getPassiveContext(true);
        const rerouteMarker = '[LATTICE_REROUTE: LANE_2]';
        
        const systemInstruction = `You are Lattice, an expert AI assistant. Answer the user's question clearly and concisely.
You have access to read-only project fetching tools (list_directory_tree, read_file_chunk, search_workspace_regex). Use them if you need to gather details about the project to answer the user's question accurately. Do not modify files.

If the question is about the active file (e.g. "here" or "this file"), find the active file path in the passive context below (look for "[Active File]: <path>") and use read_file_chunk or search_workspace_regex specifically with that path.

WHEN USING search_workspace_regex:
- ONLY use simple, plain-text patterns: "server", "url", "localhost", "http", "port", "endpoint", or specific variable/function names.
- NEVER use regex escape sequences, backslashes, or complex patterns.
- NEVER use patterns with \\, $, ^, *, +, ?, [, ], or | characters.
- If you need to search for special characters, ask the user first.
- search_workspace_regex returns matching file paths, line numbers, and line snippets. If a search result directly answers the question, answer from that result instead of continuing to search.

Hard rule: If the user explicitly asks you to edit files, rewrite code, or run terminal commands, you must respond with EXACTLY this string and nothing else: ${rerouteMarker}

${passiveContext}`;

        let isDone = false;
        let currentPrompt = prompt;
        const allowedTools = ['list_directory_tree', 'read_file_chunk', 'search_workspace_regex'];

        while (!isDone) {
            let request: ChatRequest = {
                prompt: currentPrompt,
                model,
                workspace: this.workspacePath,
                tool_history: this.toolHistory,
                chat_history: this.chatHistory,
                disableTools: false,
                allowedTools
            };

            request = ContextEngine.pruneContext(request);
            this.ui.setLoading("Thinking...");
            let response = await ModelFactory.generateWithFallback(request, systemInstruction);

            if (response.type === 'message') {
                response = this.tryParseInlineToolCall(response.content) || response;
            }

            if (response.type === 'tool_call') {
                const toolName = response.tool_name;
                const toolArgs = response.arguments;
                const targetPath = toolArgs.relative_path || '';
                let toolResultContent = '';

                this.ui.removeLoading();

                // Safety guard: if model tries to bypass and call edit/terminal tools, trigger rerouting immediately
                if (!allowedTools.includes(toolName)) {
                    this.ui.addStep('🔀', 'Rerouting', 'Lane 2 tool execution');
                    const reroutePlan = `Answer the user's request using Lane 2 capabilities.

Original Request: ${prompt}

Rules:
- This may be an information request, not an edit request.
- If the answer is visible in the active-file context, answer directly without calling tools.
- If more context is needed from the active file, prefer read_file_chunk with the active file path and relevant line range.
- If searching is needed, ONLY use search_workspace_regex with SIMPLE, PLAIN-TEXT patterns: "server", "url", "localhost", "http", "port", or "endpoint"
  - NEVER use regex escapes or backslashes
  - NEVER use patterns with \\, $, ^, *, +, ?, [, ] characters
- search_workspace_regex returns matching file paths, line numbers, and line snippets. If a search result directly answers the question, answer from that result instead of continuing to search.
- When you have the answer, respond as normal plain text. Do not call tools named print, final, answer, or respond.
- Do not edit files unless the user explicitly asked for an edit.`;
                    return await this.runExecutionFlow(prompt, reroutePlan, model);
                }

                this.updateUIStep(toolName, targetPath, toolArgs.query || toolArgs.pattern);
                this.ui.setLoading(`Executing ${toolName}...`);

                console.log(`[Lattice AgentExecutor] [Lane 1] Executing tool "${toolName}" with arguments:`, JSON.stringify(toolArgs, null, 2));

                try {
                    if (toolName === 'read_file_chunk') {
                        toolResultContent = await FileSystemTools.readFileChunk(this.workspacePath, targetPath, toolArgs.start_line, toolArgs.end_line);
                    } else if (toolName === 'list_directory_tree') {
                        toolResultContent = await FileSystemTools.listDirectoryTree(this.workspacePath, targetPath, toolArgs.depth);
                    } else if (toolName === 'search_workspace_regex') {
                        const searchPath = toolArgs.relative_path;
                        toolResultContent = await FileSystemTools.searchWorkspaceRegex(toolArgs.pattern, searchPath);
                    }
                } catch (err: any) {
                    toolResultContent = `Error executing ${toolName}: ${err.message}`;
                }

                console.log(`[Lattice AgentExecutor] [Lane 1] Tool "${toolName}" returned:`, toolResultContent);

                this.toolHistory.push({ tool_name: toolName, content: toolResultContent, arguments: toolArgs });
                this.consecutiveToolCalls++;
                if (this.consecutiveToolCalls > this.MAX_CONSECUTIVE_TOOLS) {
                    return "Maximum tool calls exceeded. Stopping to prevent loop.";
                }
            } else {
                if (response.content.includes(rerouteMarker)) {
                    this.ui.addStep('🔀', 'Rerouting', 'Lane 2 tool execution');
                    const reroutePlan = `Answer the user's request using Lane 2 capabilities.

Original Request: ${prompt}

Rules:
- This may be an information request, not an edit request.
- If the answer is visible in the active-file context, answer directly without calling tools.
- If more context is needed from the active file, prefer read_file_chunk with the active file path and relevant line range.
- If searching is needed, ONLY use search_workspace_regex with SIMPLE, PLAIN-TEXT patterns: "server", "url", "localhost", "http", "port", or "endpoint"
  - NEVER use regex escapes or backslashes
  - NEVER use patterns with \\, $, ^, *, +, ?, [, ] characters
- search_workspace_regex returns matching file paths, line numbers, and line snippets. If a search result directly answers the question, answer from that result instead of continuing to search.
- When you have the answer, respond as normal plain text. Do not call tools named print, final, answer, or respond.
- Do not edit files unless the user explicitly asked for an edit.`;
                    return await this.runExecutionFlow(prompt, reroutePlan, model);
                }
                return response.content;
            }
        }
        return "Implementation completed.";
    }

    private async generatePlan(prompt: string, model: string): Promise<string> {
        const passiveContext = await ContextEngine.getPassiveContext(false);
        const systemInstruction = `Create a detailed step-by-step plan to implement the user's request. Do not call tools yet. Be specific about which files will be modified. ${passiveContext}`;
        const request = { prompt, model, workspace: this.workspacePath, tool_history: [], chat_history: this.chatHistory };
        const response = await ModelFactory.generateWithFallback(request, systemInstruction);
        return response.type === 'message' ? response.content : "Failed to generate plan.";
    }

    private async createReviewedPlan(prompt: string, planModel: string, criticModel: string): Promise<string> {
        this.ui.setLoading("Architecting plan...");
        this.ui.statusUpdate?.('Architecting plan...');
        let plan = await this.generatePlan(prompt, planModel);
        this.ui.addStep('📝', 'Planning', 'Drafting implementation steps');

        this.ui.setLoading("Reviewing plan...");
        this.ui.statusUpdate?.('Reviewing plan (L2 Critic)...');
        const review = await Critic.reviewPlan(prompt, plan, this.chatHistory, criticModel);
        if (!review.approved) {
            this.ui.addStep('⚠️', 'Critic Review', 'Correction suggested');
            this.ui.setLoading("Refining plan...");
            plan = await this.refinePlan(prompt, plan, review.feedback || '', planModel);
            this.ui.addStep('🔄', 'Planning', 'Plan refined based on Critic feedback');
            this.ui.setLoading("Rechecking refined plan...");
            const refinedReview = await Critic.reviewPlan(prompt, plan, this.chatHistory, criticModel);
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
            const passiveContext = await ContextEngine.getPassiveContext(true);
            const systemInstruction = `You are Lattice. Execute the implementation plan surgically.

You only have partial visibility into the user's active file to save memory. If you need to understand the full structure or find specific variables, you MUST use the search_workspace_regex or read_file_chunk tools before attempting an edit.

For information requests, answer directly when the visible active-file context contains the answer. If you need tools for an information request, prefer read_file_chunk for the active file. 

WHEN USING search_workspace_regex:
- ONLY use simple, plain-text patterns: "server", "url", "localhost", "http", "port", "endpoint"
- NEVER use regex escape sequences, backslashes, or complex patterns
- NEVER use patterns like: "server\\s*:", "url.*http", or any regex with \, $, ^, *, +, ?, [, ]
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
                    } else if (McpClient.isMcpTool(toolName)) {
                        toolResultContent = await McpClient.executeMcpTool(toolName, toolArgs);
                    } else {
                        throw new Error(`Unknown tool: ${toolName}`);
                    }
                } catch (err: any) {
                    toolResultContent = `Error executing ${toolName}: ${err.message}`;
                }

                console.log(`[Lattice AgentExecutor] [Lane 2] Tool "${toolName}" returned:`, toolResultContent);

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
        else if (McpClient.isMcpTool(toolName)) { icon = '🔌'; action = 'MCP Tool'; targetPath = toolName; }
        this.ui.addStep(icon, action, targetPath);
        this.ui.statusUpdate?.(`${action}: ${targetPath}`);
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
