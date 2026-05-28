/**
 * Lane 3 — ReAct Planner (Reason → Act → Observe loop)
 * 
 * A single intelligent agent that progressively deepens its understanding
 * of the codebase before drafting a plan — like Codex/Cursor/Devin.
 * 
 * KEY FEATURES:
 * - Displays reasoning/thinking to the user (Codex-style)
 * - Shows detailed tool call info ("Reading frontend/index.html lines 1-260")
 * - Progressive deepening: structure → targets → scope → behaviors → plan
 * - Prevents duplicate tool calls via tracking
 * - On re-draft passes, can fetch additional context
 */

import { ChatMessage, ChatRequest, ToolResponse, AIResponse } from '../../../types/schemas';
import { ModelFactory } from '../../../models/ModelFactory';
import { FileSystemTools } from '../../../tools/FileSystem';
import { ContextEngine } from '../../ContextEngine';
import { IAgentUI } from '../../AgentExecutor';

export class ReActPlanner {
    private static readonly MAX_TOOL_CALLS = 25;

    /**
     * Explores the codebase and drafts a step-by-step implementation plan.
     * Surfaces reasoning to the UI between each tool call.
     */
    static async plan(
        prompt: string,
        model: string,
        history: ChatMessage[],
        workspacePath: string,
        ui: IAgentUI,
        feedback?: string
    ): Promise<{ plan: string; contextSummary: string }> {
        let toolHistory: ToolResponse[] = [];
        let consecutiveToolCalls = 0;
        let isDone = false;
        let collectedFiles: string[] = [];
        let previousToolCalls: string[] = []; // Track to prevent duplicates

        const feedbackSection = feedback
            ? `\n\n--- FEEDBACK FROM PREVIOUS REVIEW ---
${feedback}
You MUST address all points in this feedback. If the feedback mentions missing files or context, use your tools to read those files BEFORE re-drafting.
--- END FEEDBACK ---`
            : '';

        const systemInstruction = `You are Lattice, an expert code architect. Your job is to deeply explore a codebase and produce a precise, actionable implementation plan.

## HOW TO THINK

After each tool result, you will be asked to share your reasoning. This reasoning is displayed to the user as a thinking step (like Codex). Write 2-3 concise, insightful sentences explaining:
- What you just LEARNED from the previous tool result (specific facts, not vague summaries)
- What critical behaviors, patterns, or contracts you identified
- What you need to investigate next and WHY

Make your thinking INSIGHTFUL, not procedural. Instead of "I will now read the file", write "The project uses Flask with a single /api/chat endpoint returning JSON. I need to read the frontend to map the full request/response contract."

## EXPLORATION STRATEGY

**Step 1 — MAP the project:** Run list_directory_tree on "." with depth 2-3 to see the full project structure. Never guess paths.

**Step 2 — READ FULL FILES:** For every file directly relevant to the user's request, use read_full_file to read the ENTIRE file in one call. Do NOT use read_file_chunk with tiny line ranges like 1-10 — you will miss critical context. Only use read_file_chunk for files over 500 lines where you need a specific section.

**Step 3 — TARGETED SEARCH:** Only search for SPECIFIC identifiers you discovered while reading files (e.g., function names like "handleSubmit", API routes like "/api/chat", variable names like "serverUrl"). NEVER search for generic terms like "frontend", "react", "javascript", "import", "class", or framework names.

**Step 4 — EXTRACT BEHAVIORS:** After reading the key files, mentally note the exact:
- API endpoints and their request/response contracts
- UI screens/states and navigation flow  
- Key functions, classes, and their responsibilities
- Configuration values and environment variables

**Step 5 — FILL GAPS:** If you realize you're missing context about a specific file or function referenced in code you already read, read it now.

**Step 6 — PLAN:** Only when you can reference exact file paths, function names, variable names, and line numbers from the code you read, output your plan in <FINAL_PLAN>...<\/FINAL_PLAN> tags.

## CRITICAL RULES

1. ALWAYS prefer read_full_file over read_file_chunk for files under 500 lines. Reading 10 lines at a time is wasteful.
2. NEVER search for generic/framework terms. Only search for specific identifiers found in code.
3. NEVER call the same tool with the same arguments twice.
4. NEVER call list_directory_tree more than 3 times total.
5. Do NOT use edit_file_diff or execute_command during planning.
6. Do NOT ask the user for file paths or permission. You are autonomous.
7. Do NOT output <FINAL_PLAN> until you have read enough code to reference exact file paths, function names, and variable names.
8. Your thinking is displayed to the user — make it insightful and concise (2-3 sentences). State what you LEARNED, not what you will do.
9. NEVER search for patterns that don't exist in the codebase. Only search for identifiers you SAW in files you already read.`;

        const passiveContext = await ContextEngine.getPassiveContext(false);
        let currentPrompt = `User Request: ${prompt}${feedbackSection}\n\n${passiveContext}`;

        while (!isDone) {
            if (ui.isCancelled?.()) {
                throw new Error('Generation aborted by user.');
            }
            const request: ChatRequest = {
                prompt: currentPrompt,
                model: model,
                workspace: workspacePath,
                tool_history: toolHistory,
                chat_history: history,
                disableTools: false
            };

            ui.setLoading(feedback ? 'Re-planning...' : 'Planning...');

            let data: AIResponse;
            try {
                data = await ModelFactory.generateWithFallback(
                    ContextEngine.pruneContext(request),
                    systemInstruction
                );
            } catch (e: any) {
                toolHistory.push({
                    tool_name: 'system_error',
                    content: `API Error: ${e.message}\nFix your tool arguments and try again. Remember: list_directory_tree requires "relative_path", read_file_chunk requires "relative_path".`,
                    arguments: {}
                });
                consecutiveToolCalls++;
                if (consecutiveToolCalls > this.MAX_TOOL_CALLS) { break; }
                continue;
            }

            // Handle inline tool calls embedded in text
            if (data.type === 'message') {
                data = ReActPlanner.tryParseInlineToolCall(data.content) || data;
            }

            if (data.type === 'tool_call') {
                const toolName = data.tool_name;
                const toolArgs = data.arguments;
                const targetPath = toolArgs.relative_path || '';

                // Block non-planning tools
                if (toolName === 'edit_file_diff' || toolName === 'execute_command') {
                    toolHistory.push({
                        tool_name: toolName,
                        content: `Error: You cannot use ${toolName} during planning. Continue exploring, then output <FINAL_PLAN>.`,
                        arguments: toolArgs
                    });
                    consecutiveToolCalls++;
                    continue;
                }

                // Detect duplicate tool calls
                const callSignature = `${toolName}:${JSON.stringify(toolArgs)}`;
                if (previousToolCalls.includes(callSignature)) {
                    toolHistory.push({
                        tool_name: toolName,
                        content: `Error: You already made this exact tool call. Do NOT repeat tool calls. Move on to the next step or output your <FINAL_PLAN>.`,
                        arguments: toolArgs
                    });
                    consecutiveToolCalls++;
                    if (consecutiveToolCalls > this.MAX_TOOL_CALLS) { break; }
                    continue;
                }
                previousToolCalls.push(callSignature);

                // ─── Display reasoning and tool info (Codex-style) ─────────
                ui.removeLoading();
                const toolDescription = ReActPlanner.describeToolCall(toolName, toolArgs);
                ui.addStep(toolDescription.icon, toolDescription.action, toolDescription.detail);
                ui.setLoading(`${toolDescription.action}: ${toolDescription.detail}...`);

                let chatMessage = '';
                if (data.reasoning) {
                    const cleanReasoning = data.reasoning.replace(/<\/?THINKING>/gi, '').trim();
                    if (cleanReasoning) {
                        chatMessage += cleanReasoning + '\n\n';
                    }
                }
                chatMessage += `> **${toolDescription.icon} Ran ${toolDescription.action}** on \`${toolDescription.detail}\``;
                
                if (ui.addMessage) {
                    ui.addMessage(chatMessage, false);
                }

                // Execute the tool
                let toolResultContent = '';
                try {
                    if (toolName === 'read_full_file') {
                        toolResultContent = await FileSystemTools.readFullFile(
                            workspacePath, targetPath
                        );
                        collectedFiles.push(targetPath);
                    } else if (toolName === 'read_file_chunk') {
                        toolResultContent = await FileSystemTools.readFileChunk(
                            workspacePath, targetPath, toolArgs.start_line, toolArgs.end_line
                        );
                        collectedFiles.push(targetPath);
                    } else if (toolName === 'list_directory_tree') {
                        toolResultContent = await FileSystemTools.listDirectoryTree(
                            workspacePath, targetPath, toolArgs.depth
                        );
                    } else if (toolName === 'search_workspace_regex') {
                        toolResultContent = await FileSystemTools.searchWorkspaceRegex(
                            toolArgs.pattern, toolArgs.relative_path
                        );
                    } else {
                        toolResultContent = `Error: Tool "${toolName}" is not permitted during planning.`;
                    }
                } catch (err: any) {
                    toolResultContent = `Error executing ${toolName}: ${err.message}`;
                }

                toolHistory.push({ tool_name: toolName, content: toolResultContent, arguments: toolArgs });
                consecutiveToolCalls++;

                // ── THINKING PHASE: Force model to reason before next action ──
                // Separate LLM call with tools DISABLED so model MUST output text
                if (consecutiveToolCalls <= this.MAX_TOOL_CALLS) {
                    try {
                        if (ui.isCancelled?.()) {
                            throw new Error('Generation aborted by user.');
                        }
                        ui.setLoading('Thinking...');
                        const thinkRequest: ChatRequest = {
                            prompt: currentPrompt,
                            model: model,
                            workspace: workspacePath,
                            tool_history: toolHistory,
                            chat_history: history,
                            disableTools: true
                        };

                        const thinkData = await ModelFactory.generateWithFallback(
                            ContextEngine.pruneContext(thinkRequest),
                            systemInstruction
                        );

                        if (thinkData.type === 'message') {
                            const thinkText = thinkData.content
                                .replace(/<\/?THINKING>/gi, '')
                                .trim();

                            // Check if model output the final plan during thinking
                            if (thinkText.includes('<FINAL_PLAN>')) {
                                const match = thinkText.match(/<FINAL_PLAN>([\s\S]*?)<\/FINAL_PLAN>/);
                                const plan = match ? match[1].trim() : thinkText;
                                const preplanText = thinkText.split('<FINAL_PLAN>')[0].trim();
                                if (preplanText && ui.addMessage) {
                                    ui.addMessage(preplanText, false);
                                }
                                ui.removeLoading();
                                ui.addStep('📝', 'Plan Ready', feedback ? 'Plan re-drafted' : 'Implementation plan drafted');
                                const contextSummary = ReActPlanner.buildContextSummary(collectedFiles, toolHistory);
                                return { plan, contextSummary };
                            }

                            // Display thinking to user (Codex-style)
                            if (thinkText) {
                                ui.removeLoading();
                                if (ui.addMessage) {
                                    const lines = thinkText.split('\n').filter(l => l.trim());
                                    const displayText = lines.slice(0, 4).join('\n');
                                    ui.addMessage(displayText, false);
                                }
                                toolHistory.push({
                                    tool_name: 'planner_reasoning',
                                    content: thinkText,
                                    arguments: {}
                                });
                            }
                        }
                    } catch (e: any) {
                        if (e.message?.includes('aborted')) { throw e; }
                        console.error('[Lattice] Thinking phase failed:', e.message);
                    }
                }

                if (consecutiveToolCalls > this.MAX_TOOL_CALLS) {
                    toolHistory.push({
                        tool_name: 'system_warning',
                        content: `You have used ${this.MAX_TOOL_CALLS} tool calls. Output your <FINAL_PLAN> NOW.`,
                        arguments: {}
                    });
                }
            } else {
                // ─── Agent returned text ──────────────────────────────
                // Check if it contains reasoning without a final plan (intermediate thinking)
                const hasPlan = data.content.includes('<FINAL_PLAN>');

                if (!hasPlan) {
                    // This is intermediate reasoning — display truncated version to user
                    ui.removeLoading();
                    const cleanText = data.content
                        .replace(/<\/?THINKING>/gi, '')
                        .trim();
                    if (cleanText && ui.addMessage) {
                        // Truncate verbose reasoning to max 3 lines for display
                        const lines = cleanText.split('\n').filter(l => l.trim());
                        const displayText = lines.slice(0, 3).join('\n');
                        ui.addMessage(displayText, false);
                    }
                    // Still pass full reasoning to tool history for context
                    toolHistory.push({
                        tool_name: 'planner_reasoning',
                        content: cleanText,
                        arguments: {}
                    });
                    consecutiveToolCalls++;
                    if (consecutiveToolCalls > this.MAX_TOOL_CALLS) { break; }
                    continue;
                }

                // Extract the final plan
                const match = data.content.match(/<FINAL_PLAN>([\s\S]*?)<\/FINAL_PLAN>/);
                const plan = match ? match[1].trim() : data.content;

                // Display any reasoning that came before the plan
                const preplanText = data.content.split('<FINAL_PLAN>')[0]
                    .replace(/<\/?THINKING>/gi, '')
                    .trim();
                if (preplanText && ui.addMessage) {
                    ui.addMessage(preplanText, false);
                }

                ui.removeLoading();
                ui.addStep('📝', 'Plan Ready', feedback ? 'Plan re-drafted' : 'Implementation plan drafted');

                const contextSummary = ReActPlanner.buildContextSummary(collectedFiles, toolHistory);
                return { plan, contextSummary };
            }
        }

        ui.removeLoading();
        return {
            plan: 'Error: Planner exceeded maximum tool calls without producing a plan.',
            contextSummary: `Files explored: ${collectedFiles.join(', ')}`
        };
    }

    /**
     * Creates a human-readable description of a tool call for the UI.
     * Instead of "📂 Scanning: .rontend", shows "📂 Listing: ./frontend (depth 2)"
     */
    private static describeToolCall(toolName: string, args: Record<string, any>): { icon: string; action: string; detail: string } {
        const path = args.relative_path || '.';

        if (toolName === 'list_directory_tree') {
            const depth = args.depth ? ` (depth ${args.depth})` : '';
            return { icon: '📂', action: 'Listing', detail: `${path}${depth}` };
        }
        if (toolName === 'read_full_file') {
            return { icon: '📄', action: 'Reading', detail: `${path} (full file)` };
        }
        if (toolName === 'read_file_chunk') {
            const lines = (args.start_line && args.end_line)
                ? ` (lines ${args.start_line}-${args.end_line})`
                : '';
            return { icon: '📄', action: 'Reading', detail: `${path}${lines}` };
        }
        if (toolName === 'search_workspace_regex') {
            const scope = path !== '.' ? ` in ${path}` : '';
            return { icon: '🔍', action: 'Searching', detail: `"${args.pattern}"${scope}` };
        }
        return { icon: '🔧', action: toolName, detail: JSON.stringify(args).substring(0, 80) };
    }

    /**
     * Builds a context summary for the Critic to verify against.
     */
    private static buildContextSummary(collectedFiles: string[], toolHistory: ToolResponse[]): string {
        const parts: string[] = [];

        if (collectedFiles.length > 0) {
            const uniqueFiles = [...new Set(collectedFiles)];
            parts.push(`## Files Read\n${uniqueFiles.map(f => `- ${f}`).join('\n')}`);
        }

        const searchResults = toolHistory
            .filter(t => t.tool_name === 'search_workspace_regex')
            .map(t => `- "${t.arguments.pattern}": ${t.content.substring(0, 300)}`);
        if (searchResults.length > 0) {
            parts.push(`## Searches Performed\n${searchResults.join('\n')}`);
        }

        const reasoning = toolHistory
            .filter(t => t.tool_name === 'planner_reasoning')
            .map(t => t.content)
            .join('\n');
        if (reasoning) {
            parts.push(`## Planner Reasoning\n${reasoning.substring(0, 1000)}`);
        }

        return parts.join('\n\n') || 'No context summary available.';
    }

    /**
     * Attempts to parse inline tool calls embedded in text.
     */
    private static tryParseInlineToolCall(content: string): AIResponse | null {
        if (content.includes('<FINAL_PLAN>')) { return null; }

        const matches = content.match(/\{[^{}]*(?:"pattern"|"relative_path")[^{}]*\}/g);
        if (!matches) { return null; }

        for (const match of matches) {
            try {
                const args = JSON.parse(match);
                if (typeof args.pattern === 'string') {
                    return { type: 'tool_call', tool_name: 'search_workspace_regex', arguments: args };
                }
                if (typeof args.relative_path === 'string') {
                    if (typeof args.start_line === 'number' && typeof args.end_line === 'number') {
                        return { type: 'tool_call', tool_name: 'read_file_chunk', arguments: args };
                    }
                    return { type: 'tool_call', tool_name: 'list_directory_tree', arguments: args };
                }
            } catch { continue; }
        }
        return null;
    }
}
