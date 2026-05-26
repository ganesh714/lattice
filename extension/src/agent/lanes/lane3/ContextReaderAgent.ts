/**
 * Lane 3 — Agent 1: Context Reader
 * 
 * Follows the SearchPlan from Step 0 and uses tools (list_directory_tree,
 * search_workspace_regex, read_file_chunk) to gather all relevant raw code
 * from the workspace.
 * 
 * This agent is the "eyes" of the pipeline — it reads the codebase so that
 * downstream agents (Arch Extractor, Planner) don't have to guess.
 */

import { ChatMessage, ChatRequest, ToolResponse, AIResponse } from '../../../types/schemas';
import { ModelFactory } from '../../../models/ModelFactory';
import { FileSystemTools } from '../../../tools/FileSystem';
import { ContextEngine } from '../../ContextEngine';
import { IAgentUI } from '../../AgentExecutor';
import { SearchPlan } from './types';

export class ContextReaderAgent {
    private static readonly MAX_TOOL_CALLS = 15;

    /**
     * Gathers relevant code from the workspace by following the SearchPlan.
     * Returns an array of raw code chunks (each prefixed with file path).
     */
    static async gatherContext(
        searchPlan: SearchPlan,
        workspacePath: string,
        model: string,
        history: ChatMessage[],
        ui: IAgentUI
    ): Promise<string[]> {
        const collectedChunks: string[] = [];
        let toolHistory: ToolResponse[] = [];
        let consecutiveToolCalls = 0;
        let isDone = false;

        const searchPlanText = `Search Plan:
- Search terms: ${searchPlan.search_terms.join(', ')}
- Likely directories: ${searchPlan.likely_dirs.join(', ')}
- Key entities: ${searchPlan.key_entities.join(', ')}`;

        const systemInstruction = `You are a code exploration agent. Your ONLY job is to find and read relevant source files from the workspace.

You have been given a Search Plan. Follow it precisely:
1. FIRST, run list_directory_tree on "." to see the project structure.
2. Then, use search_workspace_regex to find files matching the search terms.
3. Then, use read_file_chunk to read the most relevant files found.

RULES:
- You may ONLY use these tools: list_directory_tree, search_workspace_regex, read_file_chunk.
- Do NOT use edit_file_diff, execute_command, or any other tool.
- ONLY use simple, plain-text patterns for search_workspace_regex. NEVER use regex with \\, $, ^, *, +, ?, [, ].
- Read at most 200 lines per file chunk to avoid context overflow.
- When you have gathered enough context (at least the key files), output a message starting with "CONTEXT_COMPLETE" followed by a summary of what you found.
- Do NOT output a plan. Do NOT attempt edits. Your only purpose is reading files.`;

        let currentPrompt = searchPlanText;

        while (!isDone) {
            const request: ChatRequest = {
                prompt: currentPrompt,
                model: model,
                workspace: workspacePath,
                tool_history: toolHistory,
                chat_history: history,
                disableTools: false
            };

            ui.setLoading('Agent 1: Exploring codebase...');

            let data: AIResponse;
            try {
                data = await ModelFactory.generateWithFallback(
                    ContextEngine.pruneContext(request),
                    systemInstruction
                );
            } catch (e: any) {
                toolHistory.push({
                    tool_name: 'system_error',
                    content: `API Error: ${e.message}. Fix your tool arguments and try again.`,
                    arguments: {}
                });
                consecutiveToolCalls++;
                if (consecutiveToolCalls > this.MAX_TOOL_CALLS) { break; }
                continue;
            }

            if (data.type === 'tool_call') {
                const toolName = data.tool_name;
                const toolArgs = data.arguments;
                const targetPath = toolArgs.relative_path || '';
                let toolResultContent = '';

                // Block any non-read tools
                if (!['read_file_chunk', 'list_directory_tree', 'search_workspace_regex'].includes(toolName)) {
                    toolHistory.push({
                        tool_name: toolName,
                        content: `Error: Tool "${toolName}" is not permitted for the Context Reader agent. Only read_file_chunk, list_directory_tree, and search_workspace_regex are allowed.`,
                        arguments: toolArgs
                    });
                    consecutiveToolCalls++;
                    if (consecutiveToolCalls > this.MAX_TOOL_CALLS) { break; }
                    continue;
                }

                ui.removeLoading();
                let icon = '📂'; let action = 'Scanning';
                if (toolName === 'read_file_chunk') { icon = '📄'; action = 'Reading'; }
                else if (toolName === 'search_workspace_regex') { icon = '🔍'; action = 'Searching'; }
                ui.addStep(icon, action, targetPath || toolArgs.pattern || '.');
                ui.setLoading(`Agent 1: ${action} ${targetPath || ''}...`);

                try {
                    if (toolName === 'read_file_chunk') {
                        toolResultContent = await FileSystemTools.readFileChunk(
                            workspacePath, targetPath, toolArgs.start_line, toolArgs.end_line
                        );
                        // Collect the chunk for downstream agents
                        collectedChunks.push(`[File: ${targetPath}]\n${toolResultContent}`);
                    } else if (toolName === 'list_directory_tree') {
                        toolResultContent = await FileSystemTools.listDirectoryTree(
                            workspacePath, targetPath, toolArgs.depth
                        );
                    } else if (toolName === 'search_workspace_regex') {
                        toolResultContent = await FileSystemTools.searchWorkspaceRegex(
                            toolArgs.pattern, toolArgs.relative_path
                        );
                    }
                } catch (err: any) {
                    toolResultContent = `Error executing ${toolName}: ${err.message}`;
                }

                toolHistory.push({ tool_name: toolName, content: toolResultContent, arguments: toolArgs });
                consecutiveToolCalls++;
                if (consecutiveToolCalls > this.MAX_TOOL_CALLS) { break; }
            } else {
                // Agent finished — it output a message (should start with CONTEXT_COMPLETE)
                isDone = true;
            }
        }

        // If no chunks were collected, return a fallback message
        if (collectedChunks.length === 0) {
            collectedChunks.push('[No relevant files found. The planner should use its own tools to explore.]');
        }

        ui.removeLoading();
        ui.addStep('✅', 'Context', `Gathered ${collectedChunks.length} code chunks`);
        return collectedChunks;
    }
}
