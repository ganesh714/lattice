/**
 * Lane 3 — Agent 3: Planner
 * 
 * Receives the SharedContextBundle (architecture map + raw chunks + user prompt).
 * Drafts a step-by-step implementation plan. Has READ-ONLY tool access so it can
 * fetch missing context on re-draft passes (fixes Issue #2: no feedback loop to Agent 1).
 * 
 * On a re-draft pass (triggered by Critic rejection or Human feedback), the Planner
 * can use read_file_chunk and search_workspace_regex to fill in any gaps.
 */

import { ChatMessage, ChatRequest, ToolResponse, AIResponse } from '../../../types/schemas';
import { ModelFactory } from '../../../models/ModelFactory';
import { FileSystemTools } from '../../../tools/FileSystem';
import { ContextEngine } from '../../ContextEngine';
import { IAgentUI } from '../../AgentExecutor';
import { SharedContextBundle } from './types';

export class PlannerAgent {
    private static readonly MAX_TOOL_CALLS = 10;

    /**
     * Drafts a step-by-step implementation plan using the shared context bundle.
     * Has read-only tool access for fetching additional context if needed.
     * 
     * @param bundle - The shared context from Agent 1 and Agent 2
     * @param feedback - Optional feedback from Critic or Human for re-draft passes
     */
    static async draft(
        bundle: SharedContextBundle,
        model: string,
        history: ChatMessage[],
        workspacePath: string,
        ui: IAgentUI,
        feedback?: string
    ): Promise<string> {
        let toolHistory: ToolResponse[] = [];
        let consecutiveToolCalls = 0;
        let isDone = false;

        // Serialize the architecture map for the prompt
        const archMapText = bundle.architectureMap.files.map(f => {
            let fileSection = `### ${f.filePath}`;
            if (f.exports.length > 0) { fileSection += `\nExports: ${f.exports.join(', ')}`; }
            if (f.imports.length > 0) { fileSection += `\nImports:\n${f.imports.join('\n')}`; }
            if (f.interfaces.length > 0) { fileSection += `\nInterfaces:\n${f.interfaces.join('\n')}`; }
            if (f.keyVariables.length > 0) { fileSection += `\nKey Variables: ${f.keyVariables.join(', ')}`; }
            return fileSection;
        }).join('\n\n');

        const dependenciesText = bundle.architectureMap.dependencies.length > 0
            ? `\nDependency Chains:\n${bundle.architectureMap.dependencies.join('\n')}`
            : '';

        const feedbackSection = feedback
            ? `\n\n--- FEEDBACK FROM PREVIOUS REVIEW ---\n${feedback}\nYou MUST address all points in this feedback. If the feedback mentions missing files or context, use your read-only tools (read_file_chunk, search_workspace_regex) to gather the missing information before drafting.\n--- END FEEDBACK ---`
            : '';

        const systemInstruction = `You are a senior software engineer drafting an implementation plan.

You have been given:
1. The user's original request
2. A structured Architecture Map of the relevant codebase (with exact interfaces, exports, imports)
3. Read-only tool access to fetch any ADDITIONAL files you need

AVAILABLE TOOLS (read-only):
- read_file_chunk: Read a section of a file
- search_workspace_regex: Search for patterns in the workspace (use simple plain-text patterns ONLY)
- list_directory_tree: List directory structure

PLANNING RULES:
1. Reference EXACT function names, class names, and variable names from the Architecture Map. Do NOT invent new names.
2. For each step, specify the EXACT file path and the EXACT code changes needed.
3. Consider edge cases, error handling, and backward compatibility.
4. If you need to see a file that is not in the Architecture Map, use your tools to read it BEFORE planning.
5. Do NOT use edit_file_diff or execute_command — you are planning only.

When your plan is complete, wrap it in <FINAL_PLAN>...</FINAL_PLAN> tags.`;

        let currentPrompt = `User Request: "${bundle.userPrompt}"

## Architecture Map
${archMapText}
${dependenciesText}
${feedbackSection}

Draft a detailed, step-by-step implementation plan. Use your tools if you need additional context.`;

        while (!isDone) {
            const request: ChatRequest = {
                prompt: currentPrompt,
                model: model,
                workspace: workspacePath,
                tool_history: toolHistory,
                chat_history: history,
                disableTools: false,
                allowedTools: ['read_file_chunk', 'search_workspace_regex', 'list_directory_tree']
            };

            ui.setLoading(feedback ? 'Agent 3: Re-drafting plan...' : 'Agent 3: Drafting plan...');

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

                // Block non-read tools
                if (!['read_file_chunk', 'list_directory_tree', 'search_workspace_regex'].includes(toolName)) {
                    toolHistory.push({
                        tool_name: toolName,
                        content: `Error: Tool "${toolName}" is not permitted during planning. Only read-only tools are allowed.`,
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
                ui.addStep(icon, `Planner ${action}`, targetPath || toolArgs.pattern || '.');
                ui.setLoading(`Agent 3: ${action} additional context...`);

                try {
                    if (toolName === 'read_file_chunk') {
                        toolResultContent = await FileSystemTools.readFileChunk(
                            workspacePath, targetPath, toolArgs.start_line, toolArgs.end_line
                        );
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
                // Extract the plan from <FINAL_PLAN> tags
                const match = data.content.match(/<FINAL_PLAN>([\s\S]*?)<\/FINAL_PLAN>/);
                if (match) {
                    ui.removeLoading();
                    ui.addStep('📝', 'Planning', feedback ? 'Plan re-drafted' : 'Plan drafted');
                    return match[1].trim();
                }
                // If no tags, return the full response as the plan
                ui.removeLoading();
                ui.addStep('📝', 'Planning', feedback ? 'Plan re-drafted' : 'Plan drafted');
                return data.content;
            }
        }

        ui.removeLoading();
        return 'Error: Planner exceeded maximum tool calls without producing a plan.';
    }
}
