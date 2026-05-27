/**
 * Lane 3 — ReAct Planner (Reason → Act → Observe loop)
 * 
 * Replaces the over-split Agent 1 + Agent 2 + Agent 3 pipeline with a single
 * intelligent agent that progressively deepens its understanding of the codebase
 * before drafting a plan — exactly how Codex/Cursor/Devin work.
 * 
 * The agent follows a 6-level progressive deepening strategy:
 *   Level 1: WIDE SCAN     → Project structure (ls, tree)
 *   Level 2: IDENTIFY       → Entry points, configs, key files
 *   Level 3: ASSESS SCOPE   → Read key files, understand scale
 *   Level 4: EXTRACT        → Targeted grep for behaviors, APIs, patterns
 *   Level 5: DEEP READ      → Fill remaining gaps
 *   Level 6: PLAN           → Draft implementation plan
 * 
 * Between each action, the agent MUST output <THINKING> blocks to reason about
 * what it learned and what it still needs — this prevents blind tool-calling.
 * 
 * On re-draft passes (Critic/Human feedback), the same agent can fetch
 * additional context using its tools.
 */

import { ChatMessage, ChatRequest, ToolResponse, AIResponse } from '../../../types/schemas';
import { ModelFactory } from '../../../models/ModelFactory';
import { FileSystemTools } from '../../../tools/FileSystem';
import { ContextEngine } from '../../ContextEngine';
import { IAgentUI } from '../../AgentExecutor';

export class ReActPlanner {
    private static readonly MAX_TOOL_CALLS = 25;

    /**
     * Explores the codebase and drafts a step-by-step implementation plan
     * using a ReAct (Reason → Act → Observe) loop.
     * 
     * Also collects a context summary for the Critic agent to verify against.
     * 
     * @param feedback - Optional feedback from Critic or Human for re-draft passes
     * @returns Object containing the plan and the collected context summary
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

        const feedbackSection = feedback
            ? `\n\n--- FEEDBACK FROM PREVIOUS REVIEW ---
${feedback}
You MUST address all points in this feedback. If the feedback mentions missing files or context, use your tools to read those files BEFORE re-drafting.
--- END FEEDBACK ---`
            : '';

        const systemInstruction = `You are Lattice, an expert code architect. Your job is to deeply understand a codebase and produce a precise, actionable implementation plan.

## HOW YOU WORK — Progressive Deepening Strategy

You MUST follow this exploration strategy in order:

**Level 1 — WIDE SCAN:** Run list_directory_tree on "." FIRST to see the full project structure. Never guess directory names.

**Level 2 — IDENTIFY TARGETS:** From the tree, identify which files are relevant (configs, entry points, components, tests). State what you found.

**Level 3 — ASSESS SCOPE:** Read the key files using read_file_chunk. Determine if the project is large or small. Adjust your approach — for a small project, read everything. For a large one, be surgical.

**Level 4 — EXTRACT BEHAVIORS:** Use search_workspace_regex to find specific patterns: API calls (fetch, axios), event handlers, state management, routing, etc. Only use simple plain-text search patterns — NEVER use regex escape sequences like \\s, \\b, or complex patterns.

**Level 5 — FILL GAPS:** Read any remaining sections you haven't covered. Make sure you understand the full behavior before planning.

**Level 6 — DRAFT PLAN:** Only when you are confident you understand the codebase, output your plan in <FINAL_PLAN>...</FINAL_PLAN> tags.

## MANDATORY REASONING

Before EVERY tool call, you MUST output your current thinking in <THINKING>...</THINKING> tags. This must include:
1. What you just learned from the previous observation
2. What question you still need answered
3. Why you are choosing this specific next action

Example:
<THINKING>
I just read the project structure. The frontend is a single HTML file with no build tools.
This is unusually minimal — I need to read the entire HTML to understand all UI screens and API contracts.
Next: Read the HTML file to map the complete behavior.
</THINKING>

## TOOL RULES
- ONLY use: list_directory_tree, read_file_chunk, search_workspace_regex
- Do NOT use edit_file_diff or execute_command during planning
- For search_workspace_regex: use ONLY simple plain-text patterns like "fetch", "login", "useState"
- NEVER use regex with \\, $, ^, *, +, ?, [, ]
- Read at most 300 lines per chunk (use start_line/end_line to page through large files)

## PLAN FORMAT
Your <FINAL_PLAN> must include:
1. A brief summary of what you discovered about the project
2. Step-by-step changes with EXACT file paths and EXACT function/variable names from the code you read
3. Dependencies and order of operations
4. Edge cases and error handling considerations
5. What should be tested after implementation

Do NOT output <FINAL_PLAN> until you have read enough code to reference exact identifiers.`;

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

            const statusPrefix = feedback ? 'Re-planning' : 'Planning';
            ui.setLoading(`${statusPrefix}: Exploring project...`);

            let data: AIResponse;
            try {
                data = await ModelFactory.generateWithFallback(
                    ContextEngine.pruneContext(request),
                    systemInstruction
                );
            } catch (e: any) {
                toolHistory.push({
                    tool_name: 'system_error',
                    content: `API Error: ${e.message}\nYou likely provided invalid JSON arguments to a tool. Remember, list_directory_tree requires a "relative_path" argument. Please fix your tool formatting and try again.`,
                    arguments: {}
                });
                consecutiveToolCalls++;
                if (consecutiveToolCalls > this.MAX_TOOL_CALLS) { break; }
                continue;
            }

            // Handle inline tool calls that models sometimes embed in text
            if (data.type === 'message') {
                data = ReActPlanner.tryParseInlineToolCall(data.content) || data;
            }

            if (data.type === 'tool_call') {
                const toolName = data.tool_name;
                const toolArgs = data.arguments;
                const targetPath = toolArgs.relative_path || '';
                let toolResultContent = '';

                // Block non-planning tools
                if (toolName === 'edit_file_diff' || toolName === 'execute_command') {
                    toolHistory.push({
                        tool_name: toolName,
                        content: `Error: You cannot use ${toolName} during the planning phase. Continue exploring with read-only tools, then output your <FINAL_PLAN>.`,
                        arguments: toolArgs
                    });
                    consecutiveToolCalls++;
                    continue;
                }

                // Update UI
                ui.removeLoading();
                let icon = '📂'; let action = 'Scanning';
                if (toolName === 'read_file_chunk') { icon = '📄'; action = 'Reading'; }
                else if (toolName === 'search_workspace_regex') { icon = '🔍'; action = 'Searching'; }
                ui.addStep(icon, action, targetPath || toolArgs.pattern || '.');
                ui.setLoading(`${statusPrefix}: ${action} ${targetPath || toolArgs.pattern || ''}...`);

                try {
                    if (toolName === 'read_file_chunk') {
                        toolResultContent = await FileSystemTools.readFileChunk(
                            workspacePath, targetPath, toolArgs.start_line, toolArgs.end_line
                        );
                        collectedFiles.push(`[File: ${targetPath}]`);
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
                    // Force the agent to output a plan with what it has
                    toolHistory.push({
                        tool_name: 'system_warning',
                        content: `You have used ${this.MAX_TOOL_CALLS} tool calls. You MUST output your <FINAL_PLAN> now with what you have learned so far. No more tool calls.`,
                        arguments: {}
                    });
                }
            } else {
                // Agent returned text — check for <FINAL_PLAN>
                const match = data.content.match(/<FINAL_PLAN>([\s\S]*?)<\/FINAL_PLAN>/);
                const plan = match ? match[1].trim() : data.content;

                ui.removeLoading();
                ui.addStep('📝', 'Planning', feedback ? 'Plan re-drafted' : 'Plan drafted');

                // Build a context summary for the Critic
                const contextSummary = ReActPlanner.buildContextSummary(
                    collectedFiles, toolHistory, data.content
                );

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
     * Builds a summary of what the planner discovered for the Critic to verify against.
     * Extracts <THINKING> blocks and file list as evidence.
     */
    private static buildContextSummary(
        collectedFiles: string[],
        toolHistory: ToolResponse[],
        finalResponse: string
    ): string {
        const parts: string[] = [];

        // Files explored
        if (collectedFiles.length > 0) {
            parts.push(`## Files Explored\n${collectedFiles.join('\n')}`);
        }

        // Extract thinking blocks from the final response as reasoning evidence
        const thinkingBlocks = finalResponse.match(/<THINKING>([\s\S]*?)<\/THINKING>/g);
        if (thinkingBlocks && thinkingBlocks.length > 0) {
            const lastThinking = thinkingBlocks[thinkingBlocks.length - 1]
                .replace(/<\/?THINKING>/g, '').trim();
            parts.push(`## Final Reasoning\n${lastThinking}`);
        }

        // Key search results
        const searchResults = toolHistory
            .filter(t => t.tool_name === 'search_workspace_regex')
            .map(t => `Search "${t.arguments.pattern}": ${t.content.substring(0, 200)}`);
        if (searchResults.length > 0) {
            parts.push(`## Key Searches\n${searchResults.join('\n')}`);
        }

        return parts.join('\n\n') || 'No context summary available.';
    }

    /**
     * Attempts to parse inline tool calls that models sometimes embed in text
     * instead of making proper function calls.
     */
    private static tryParseInlineToolCall(content: string): AIResponse | null {
        if (content.includes('<FINAL_PLAN>')) {
            return null; // Don't intercept if it's outputting the final plan
        }

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
