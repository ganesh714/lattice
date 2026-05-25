import * as vscode from 'vscode';
import { ILaneStrategy } from './ILaneStrategy';
import { ChatMessage, ChatRequest, ToolResponse, AIResponse } from '../../types/schemas';
import { ContextEngine } from '../ContextEngine';
import { ModelFactory } from '../../models/ModelFactory';
import { FileSystemTools } from '../../tools/FileSystem';
import { IAgentUI } from '../AgentExecutor';
import { Lane2Execution } from './Lane2Execution';

export class Lane1Chat implements ILaneStrategy {
    private toolHistory: ToolResponse[] = [];
    private consecutiveToolCalls = 0;
    private MAX_CONSECUTIVE_TOOLS = 15;

    constructor(
        private ui: IAgentUI,
        private workspacePath: string,
        private lane2Fallback: Lane2Execution
    ) {}

    async execute(prompt: string, model: string, history: ChatMessage[], settings?: any): Promise<string> {
        this.toolHistory = [];
        this.consecutiveToolCalls = 0;

        const needsActiveFileContext = this.needsActiveFileContext(prompt);

        if (needsActiveFileContext) {
            return await this.runActiveFileEvidenceFlow(prompt, model, history);
        }

        return await this.runChatFlow(prompt, model, history);
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

    private async runActiveFileEvidenceFlow(prompt: string, model: string, history: ChatMessage[]): Promise<string> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            const plan = this.createActiveFileAnswerPlan(prompt);
            return await this.lane2Fallback.runExecutionFlow(prompt, plan, model, history, this.toolHistory);
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
            prompt: `Original request: ${prompt}\n\nActive file: ${activePath}\n\nEvidence from active file:\n${evidenceText}\n\n${passiveContext}`,
            model,
            workspace: this.workspacePath,
            tool_history: [],
            chat_history: history,
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

    private async runChatFlow(prompt: string, model: string, history: ChatMessage[]): Promise<string> {
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
                chat_history: history,
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
                    const reroutePlan = this.createReroutePlan(prompt);
                    return await this.lane2Fallback.runExecutionFlow(prompt, reroutePlan, model, history, this.toolHistory);
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
                    const reroutePlan = this.createReroutePlan(prompt);
                    return await this.lane2Fallback.runExecutionFlow(prompt, reroutePlan, model, history, this.toolHistory);
                }
                return response.content;
            }
        }
        return "Implementation completed.";
    }

    private createReroutePlan(prompt: string): string {
        return `Answer the user's request using Lane 2 capabilities.

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
    }

    private updateUIStep(toolName: string, targetPath: string, extra?: any) {
        let icon = '📂'; let action = 'Scanning';
        if (toolName === 'read_file_chunk') { icon = '📄'; action = 'Reading'; }
        else if (toolName === 'search_workspace_regex') { icon = '🔍'; action = 'Searching'; targetPath = String(extra); }
        this.ui.addStep(icon, action, targetPath);
        this.ui.statusUpdate?.(`${action}: ${targetPath}`);
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
