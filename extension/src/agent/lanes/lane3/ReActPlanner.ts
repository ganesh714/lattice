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

        const systemInstruction = `You are Lattice, an expert code architect. Your job is to deeply understand a codebase and produce a precise, actionable implementation plan.

## YOUR EXPLORATION STRATEGY

Follow this exact sequence. Do NOT skip levels or jump ahead.

**Step 1 — MAP the project:** Run list_directory_tree on "." to see the full structure. Never guess paths.

**Step 2 — IDENTIFY what matters:** From the tree, determine which files are entry points, configs, and core logic. State your findings clearly.

**Step 3 — READ key files:** Use read_file_chunk to read the most important files. For small projects (< 10 files), read everything relevant. For large projects, focus on entry points and the files most related to the user's request.

**Step 4 — SEARCH for patterns:** Use search_workspace_regex with SIMPLE plain-text patterns (e.g., "fetch", "login", "import") to find specific behaviors. NEVER use regex escapes like \\s, \\b, \\d, or special chars like $, ^, *, +, ?, [, ].

**Step 5 — FILL GAPS:** If you realize you're missing context about a specific file or function, read it now.

**Step 6 — PLAN:** Only when you are confident you understand the codebase, output your plan in <FINAL_PLAN>...</FINAL_PLAN> tags.

## CRITICAL RULES

1. NEVER call the same tool with the same arguments twice. If you already scanned a directory, do NOT scan it again.
2. NEVER call list_directory_tree more than 3 times total. You should get the full picture from 1-2 scans.
3. When reading files, specify WHAT you're looking for and WHY.
4. For search_workspace_regex: ONLY use plain words like "fetch", "route", "export", "class". No regex syntax.
5. Do NOT use edit_file_diff or execute_command during planning.
6. Your text responses will be shown to the user. Write clear, concise reasoning about what you discovered and what you're doing next — like a senior engineer explaining their thought process.
7. Do NOT output <FINAL_PLAN> until you have read enough code to reference exact file paths, function names, and variable names.`;

        const passiveContext = await ContextEngine.getPassiveContext(false);
        let currentPrompt = `User Request: ${prompt}${feedbackSection}\n\n${passiveContext}`;

        while (!isDone) {
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

                // ─── Display reasoning (Codex-style) ─────────────────
                if (data.reasoning) {
                    ui.removeLoading();
                    // Clean up <THINKING> tags if present, show raw reasoning
                    const cleanReasoning = data.reasoning
                        .replace(/<\/?THINKING>/gi, '')
                        .trim();
                    if (cleanReasoning && ui.addMessage) {
                        ui.addMessage(cleanReasoning, false);
                    }
                }

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

                // ─── Display detailed tool info (Codex-style) ─────────
                ui.removeLoading();
                const toolDescription = ReActPlanner.describeToolCall(toolName, toolArgs);
                ui.addStep(toolDescription.icon, toolDescription.action, toolDescription.detail);
                ui.setLoading(`${toolDescription.action}: ${toolDescription.detail}...`);

                // Execute the tool
                let toolResultContent = '';
                try {
                    if (toolName === 'read_file_chunk') {
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
                    // This is intermediate reasoning — display it to the user
                    ui.removeLoading();
                    const cleanText = data.content
                        .replace(/<\/?THINKING>/gi, '')
                        .trim();
                    if (cleanText && ui.addMessage) {
                        ui.addMessage(cleanText, false);
                    }
                    // The model output text but no tool call and no plan — 
                    // push it back as context and continue the loop
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
