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
        let reasoningHistory: string[] = [];

        const feedbackSection = feedback
            ? `\n\n--- FEEDBACK FROM PREVIOUS REVIEW ---
${feedback}
You MUST address all points in this feedback. If the feedback mentions missing files or context, use your tools to read those files BEFORE re-drafting.
--- END FEEDBACK ---`
            : '';

        const thinkInstruction = `You are the Analyzer Agent. Your job is to review the exploration history and decide the exact next step.
You CANNOT call tools yourself, and you MUST NOT output a <FINAL_PLAN>.
Write 2-4 insightful sentences explaining:
1. What facts you just learned from the recent tool results.
2. What specific file, identifier, or directory the Acting Agent needs to investigate next. NEVER guess filenames—ONLY suggest files you have explicitly seen in the list_directory_tree output.
If you have enough context to write the implementation plan, explicitly tell the Acting Agent to output the <FINAL_PLAN>.`;

        const actInstruction = `You are the Acting Agent. Your job is to execute the action suggested by the Analyzer Agent (found in the "[Analyzer Agent Reasoning]" block at the end of your prompt).

## EXPLORATION STRATEGY
**Step 1 — MAP the project:** list_directory_tree on "." with depth 2-3.
**Step 2 — READ FULL FILES:** Use read_full_file for relevant files. NEVER use read_file_chunk for files under 500 lines.
**Step 3 — TARGETED SEARCH:** Search ONLY for specific identifiers you discovered. NEVER search for generic terms like "react", "frontend".

## CRITICAL RULES
1. If the Analyzer Agent suggests a tool call, MAKE THAT EXACT TOOL CALL. Do NOT output text.
2. If the Analyzer Agent says exploration is complete, output your plan inside <FINAL_PLAN>...</FINAL_PLAN> tags.
3. NEVER call the same tool with the same arguments twice.
4. Do NOT use edit_file_diff or execute_command during planning.`;

        const passiveContext = await ContextEngine.getPassiveContext(false);
        let currentPrompt = `User Request: ${prompt}${feedbackSection}\n\n${passiveContext}`;

        while (!isDone) {
            if (ui.isCancelled?.()) {
                throw new Error('Generation aborted by user.');
            }

            // ─── 1. ANALYZER AGENT (Thinking Phase) ───
            ui.setLoading(feedback ? 'Thinking about next step...' : 'Analyzing context...');
            const thinkRequest: ChatRequest = {
                prompt: currentPrompt,
                model: model,
                workspace: workspacePath,
                tool_history: toolHistory,
                chat_history: history,
                disableTools: true
            };

            try {
                const thinkData = await ModelFactory.generateWithFallback(
                    ContextEngine.pruneContext(thinkRequest),
                    thinkInstruction
                );

                if (thinkData.type === 'message') {
                    // Strip both <THINKING> and <think> tags so we can safely wrap the ENTIRE output
                    let text = thinkData.content.replace(/<\/?(THINKING|think)>/gi, '').trim();
                    // Analyzer is forbidden from outputting the plan, strip it if it hallucinates it
                    if (text.includes('<FINAL_PLAN>')) {
                        text = text.split('<FINAL_PLAN>')[0].trim();
                    }

                    if (text) {
                        ui.removeLoading();
                        // Wrap the ENTIRE output so it goes cleanly into the single "Thought Process" dropdown
                        const thinkUiText = `<think>\n${text}\n</think>`;
                        if (ui.addMessage) ui.addMessage(thinkUiText, false);

                        reasoningHistory.push(text);
                        currentPrompt += `\n\n[Analyzer Agent Reasoning]:\n${text}`;
                    }
                }
            } catch (e: any) {
                if (e.message?.includes('aborted')) throw e;
                console.error('[Lattice] Analyzer phase failed:', e.message);
                currentPrompt += `\n\n[System Error during Analyzer Phase]: ${e.message}`;
            }

            if (ui.isCancelled?.()) throw new Error('Generation aborted by user.');

            // ─── 2. ACTING AGENT (Tool Phase) ───
            ui.setLoading('Executing tool...');
            const actRequest: ChatRequest = {
                prompt: currentPrompt,
                model: model,
                workspace: workspacePath,
                tool_history: toolHistory,
                chat_history: history,
                disableTools: false
            };

            let data: AIResponse;
            try {
                data = await ModelFactory.generateWithFallback(
                    ContextEngine.pruneContext(actRequest),
                    actInstruction
                );
            } catch (e: any) {
                currentPrompt += `\n\n[System Error during Actor Phase]: Actor API Error: ${e.message}\nFix your tool arguments.`;
                consecutiveToolCalls++;
                if (consecutiveToolCalls > this.MAX_TOOL_CALLS) break;
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

                if (toolName === 'edit_file_diff' || toolName === 'execute_command') {
                    toolHistory.push({
                        tool_name: toolName,
                        content: `Error: You cannot use ${toolName} during planning.`,
                        arguments: toolArgs
                    });
                    consecutiveToolCalls++;
                    continue;
                }

                const callSignature = `${toolName}:${JSON.stringify(toolArgs)}`;
                if (previousToolCalls.includes(callSignature)) {
                    toolHistory.push({
                        tool_name: toolName,
                        content: `Error: You already made this exact tool call. Move on.`,
                        arguments: toolArgs
                    });
                    consecutiveToolCalls++;
                    if (consecutiveToolCalls > this.MAX_TOOL_CALLS) break;
                    continue;
                }
                previousToolCalls.push(callSignature);

                ui.removeLoading();
                const toolDescription = ReActPlanner.describeToolCall(toolName, toolArgs);
                ui.addStep(toolDescription.icon, toolDescription.action, toolDescription.detail);
                ui.setLoading(`${toolDescription.action}: ${toolDescription.detail}...`);

                // We don't need to print reasoning here because the Analyzer already did.
                // Format the tool execution as a clean dropdown matching the Thought Process UI.
                const chatMessage = `<tool_execution><summary><span class="summary-text">${toolDescription.icon} Ran ${toolDescription.action}</span></summary><div class="details-content"><code>${toolDescription.detail}</code></div></tool_execution>`;
                if (ui.addMessage) ui.addMessage(chatMessage, false);

                let toolResultContent = '';
                try {
                    if (toolName === 'read_full_file') {
                        toolResultContent = await FileSystemTools.readFullFile(workspacePath, targetPath);
                        collectedFiles.push(targetPath);
                    } else if (toolName === 'read_file_chunk') {
                        toolResultContent = await FileSystemTools.readFileChunk(workspacePath, targetPath, toolArgs.start_line, toolArgs.end_line);
                        collectedFiles.push(targetPath);
                    } else if (toolName === 'list_directory_tree') {
                        toolResultContent = await FileSystemTools.listDirectoryTree(workspacePath, targetPath, toolArgs.depth);
                    } else if (toolName === 'search_workspace_regex') {
                        toolResultContent = await FileSystemTools.searchWorkspaceRegex(toolArgs.pattern, toolArgs.relative_path);
                    } else {
                        toolResultContent = `Error: Tool "${toolName}" is not permitted.`;
                    }
                } catch (err: any) {
                    toolResultContent = `Error executing ${toolName}: ${err.message}`;
                }

                toolHistory.push({ tool_name: toolName, content: toolResultContent, arguments: toolArgs });
                consecutiveToolCalls++;

                if (consecutiveToolCalls > this.MAX_TOOL_CALLS) {
                    currentPrompt += `\n\n[System Warning]: You used ${this.MAX_TOOL_CALLS} tool calls. Output <FINAL_PLAN> NOW.`;
                }
            } else {
                // Actor returned text instead of a tool call
                const hasPlan = data.content.includes('<FINAL_PLAN>');
                if (!hasPlan) {
                    // Actor failed to call a tool or output a plan. Treat as error to force retry.
                    currentPrompt += `\n\n[System Error]: Actor Agent failed to call a tool or output a plan. It output plain text:\n${data.content}\nError: You must either call a tool or output <FINAL_PLAN>...</FINAL_PLAN>.`;
                    consecutiveToolCalls++;
                    if (consecutiveToolCalls > this.MAX_TOOL_CALLS) break;
                    continue;
                }

                // Actor output the plan!
                const match = data.content.match(/<FINAL_PLAN>([\s\S]*?)<\/FINAL_PLAN>/);
                const plan = match ? match[1].trim() : data.content;

                ui.removeLoading();
                ui.addStep('📝', 'Plan Ready', feedback ? 'Plan re-drafted' : 'Implementation plan drafted');

                const contextSummary = ReActPlanner.buildContextSummary(collectedFiles, toolHistory, reasoningHistory);
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
    private static buildContextSummary(collectedFiles: string[], toolHistory: ToolResponse[], reasoningHistory: string[]): string {
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

        const reasoning = reasoningHistory.join('\n');
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
