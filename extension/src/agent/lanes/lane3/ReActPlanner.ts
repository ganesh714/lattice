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
import { FileIntelligenceAgent } from '../../fileIntelligence/FileIntelligenceAgent';
import * as path from 'path';

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
        let totalToolCalls = 0;      // Productive tool calls toward the budget
        let errorRetries = 0;        // Recoverable errors — tracked separately so they don't eat the planning budget
        let isDone = false;
        let collectedFiles: string[] = [];
        let previousToolCalls: string[] = []; // Track to prevent duplicates
        let reasoningHistory: string[] = [];
        let discoveries: string[] = []; // Running scratchpad of confirmed facts
        const MAX_ERROR_RETRIES = 5; // Cap on recoverable errors before giving up

        const feedbackSection = feedback
            ? `\n\n--- FEEDBACK FROM PREVIOUS REVIEW ---
${feedback}
You MUST address all points in this feedback. If the feedback mentions missing files or context, use your tools to read those files BEFORE re-drafting.
--- END FEEDBACK ---`
            : '';

        const thinkInstruction = `You are the Analyzer Agent. Your ONLY job is to reason about what to investigate next.
You CANNOT call tools. You MUST NOT output a <FINAL_PLAN>. Output reasoning text only.

## HOW TO REASON (follow this exact structure every turn)

**STEP 1 — ANOMALY CHECK**
Scan the latest tool output for mismatches against what you expected or what was seen in earlier results.
Ask yourself: "Does this contradict something I saw before?" or "Is something missing that should be here?"
Examples of anomalies to catch:
- A skeleton showed 2 inputs but the function body references 4 DOM element IDs → inputs are undiscovered
- A file was listed in the directory tree but never read → blind spot
- A function references an import not yet explored → dependency chain incomplete
- An identifier in the plan doesn't appear anywhere in tool outputs → likely hallucinated

**STEP 2 — KNOWLEDGE GAP INVENTORY**
List (briefly) what you still DON'T know that is necessary to write an accurate plan.
Be specific: not "need more context" but "don't know what inputs the form has beyond \`total\` and \`attended\`".

**STEP 3 — NEXT ACTION DECISION**
State exactly ONE action for the Acting Agent to take next, with the precise file path or symbol name.
ONLY reference files/symbols you have explicitly seen in tool outputs. Never guess.
Justify WHY this action closes a specific gap from Step 2.

**STEP 4 — READY CHECK**
If and ONLY if ALL of the following are true, tell the Acting Agent to output <FINAL_PLAN>:
- Every file path you plan to reference has been read (not just listed)
- Every function/variable name in the plan was seen in actual tool output
- No anomalies remain unresolved
- Dependencies and imports are understood

## FORMAT
Write plain prose following the 4 steps above. Be direct and specific. 3-6 sentences total.
Do NOT start with "I have learned..." — start with what's wrong or missing.`;

        const actInstruction = `You are the Acting Agent. Your job is to execute the action suggested by the Analyzer Agent (found in the "[Analyzer Agent Reasoning]" block at the end of your prompt).

## EXPLORATION STRATEGY
**Step 1 — MAP the project:** list_directory_tree on "." with depth 2-3.
**Step 2 — READ FILES:** Use read_full_file for files. NEVER use read_file_chunk for files under 500 lines.
**Step 3 — LARGE FILES (>500 lines):** Do NOT read chunks blindly. Use analyze_large_file first to get the skeleton and symbol index, then use deep_dive_symbol or read_file_chunk to read specific sections.
**Step 4 — TARGETED SEARCH:** Search ONLY for specific identifiers you discovered. NEVER search for generic terms like "react", "frontend".

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
            const thinkStartTime = Date.now();

            // Build a running scratchpad of confirmed facts for the Analyzer to reason against.
            // This prevents the model from only looking at the last tool output and ignoring
            // earlier discoveries (which causes the shallow "I have learned..." pattern).
            const discoveriesScratchpad = discoveries.length > 0
                ? `\n\n## CONFIRMED FACTS SO FAR (from all tool calls)\n${discoveries.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
                : '';

            const thinkRequest: ChatRequest = {
                prompt: currentPrompt + discoveriesScratchpad,
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
                const thinkDuration = ((Date.now() - thinkStartTime) / 1000).toFixed(1);

                if (thinkData.type === 'message') {
                    // Strip both <THINKING> and <think> tags so we can safely wrap the ENTIRE output
                    let text = thinkData.content.replace(/<\/?(THINKING|think)>/gi, '').trim();
                    // Analyzer is forbidden from outputting the plan, strip it if it hallucinates it
                    if (text.includes('<FINAL_PLAN>')) {
                        text = text.split('<FINAL_PLAN>')[0].trim();
                    }
                    // Strip tool call hallucinations — small models sometimes emit <function=...> or JSON blobs
                    // from the Analyzer despite being told "You CANNOT call tools"
                    text = text.replace(/<function=\w+>\s*\{[\s\S]*?\}\s*<\/function>/g, '').trim();

                    if (text) {
                        ui.removeLoading();
                        // Wrap the ENTIRE output so it goes cleanly into the single "Thought Process" dropdown
                        const thinkUiText = `<think time="${thinkDuration}">\n${text}\n</think>`;
                        if (ui.addMessage) ui.addMessage(thinkUiText, false);

                        reasoningHistory.push(text);

                        // Prune currentPrompt before appending new reasoning to prevent
                        // unbounded context growth that degrades small models.
                        // Keep only the latest 2 Analyzer blocks — prior ones are already
                        // preserved in toolHistory (full tool results) and discoveries (extracted facts).
                        const KEEP_LAST_N_REASONING = 2;
                        const reasoningBlocks = currentPrompt.split('\n\n[Analyzer Agent Reasoning]:');
                        if (reasoningBlocks.length > KEEP_LAST_N_REASONING + 1) {
                            currentPrompt = reasoningBlocks[0] +
                                '\n\n[Analyzer Agent Reasoning]:' +
                                reasoningBlocks.slice(-(KEEP_LAST_N_REASONING)).join('\n\n[Analyzer Agent Reasoning]:');
                        }
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
            const actStartTime = Date.now();
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
                errorRetries++;
                ui.addStep('❌', 'API Error', e.message.substring(0, 80));
                
                // If it's a catastrophic API error (e.g. 503, rate limit), don't silent loop forever
                if (e.message.includes('503') || e.message.includes('429') || e.message.includes('model')) {
                    throw e; 
                }

                if (errorRetries > MAX_ERROR_RETRIES) break;
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
                    errorRetries++;
                    continue;
                }

                const callSignature = `${toolName}:${JSON.stringify(toolArgs)}`;
                if (previousToolCalls.includes(callSignature)) {
                    toolHistory.push({
                        tool_name: toolName,
                        content: `Error: You already made this exact tool call. Move on.`,
                        arguments: toolArgs
                    });
                    ui.addStep('⚠️', 'Repeated Tool', `Agent tried to call ${toolName} again.`);
                    errorRetries++;
                    if (errorRetries > MAX_ERROR_RETRIES) break;
                    continue;
                }
                previousToolCalls.push(callSignature);

                const actDuration = ((Date.now() - actStartTime) / 1000).toFixed(1);
                ui.removeLoading();
                const toolDescription = ReActPlanner.describeToolCall(toolName, toolArgs);
                ui.addStep(toolDescription.icon, toolDescription.action, toolDescription.detail);
                ui.setLoading(`${toolDescription.action}: ${toolDescription.detail}...`);

                // We don't need to print reasoning here because the Analyzer already did.
                // Format the tool execution as a clean dropdown matching the Thought Process UI.
                const chatMessage = `<tool_execution><summary><span class="summary-text">${toolDescription.icon} Ran ${toolDescription.action} <span style="opacity:0.7; font-size:0.9em; font-weight:normal;">(⏱️ ${actDuration}s)</span></span></summary><div class="details-content"><code>${toolDescription.detail}</code></div></tool_execution>`;
                if (ui.addMessage) ui.addMessage(chatMessage, false);

                let toolResultContent = '';
                const toolStartTime = Date.now();
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
                    } else if (toolName === 'analyze_large_file') {
                        const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.join(workspacePath, targetPath);
                        const result = await FileIntelligenceAgent.analyze(workspacePath, absolutePath, model);
                        toolResultContent = FileIntelligenceAgent.formatSummary(result);
                        collectedFiles.push(targetPath);
                    } else if (toolName === 'deep_dive_symbol') {
                        const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.join(workspacePath, targetPath);
                        toolResultContent = await FileIntelligenceAgent.fetchSymbol(workspacePath, absolutePath, model, toolArgs.symbol_name);
                    } else {
                        toolResultContent = `Error: Tool "${toolName}" is not permitted.`;
                    }
                } catch (err: any) {
                    toolResultContent = `Error executing ${toolName}: ${err.message}`;
                }

                const toolDuration = ((Date.now() - toolStartTime) / 1000).toFixed(1);

                toolHistory.push({ tool_name: toolName, content: toolResultContent, arguments: toolArgs });

                // Extract key confirmed facts for the Analyzer's scratchpad.
                // We record what was actually found so the Analyzer can reason
                // against the full picture, not just the most recent output.
                if (toolName === 'read_full_file' || toolName === 'read_file_chunk') {
                    discoveries.push(`Read "${targetPath}" — content is in tool history`);
                } else if (toolName === 'analyze_large_file') {
                    // Extract symbol names from the summary so the Analyzer knows what's findable
                    const symbolMatches = toolResultContent.match(/\[(?:function|class|variable|method)\] (\w+)/g);
                    if (symbolMatches) {
                        discoveries.push(`"${targetPath}" symbols: ${symbolMatches.slice(0, 10).join(', ')}`);
                    }
                } else if (toolName === 'deep_dive_symbol') {
                    const symbolName = toolArgs.symbol_name || '';
                    // Extract DOM element IDs, variable names, imports referenced in the symbol
                    const domIds = [...toolResultContent.matchAll(/getElementById\(['"]([\w]+)['"]\)/g)].map(m => m[1]);
                    const imports = [...toolResultContent.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
                    if (domIds.length > 0) discoveries.push(`"${symbolName}" references DOM IDs: ${domIds.join(', ')}`);
                    if (imports.length > 0) discoveries.push(`"${symbolName}" imports: ${imports.join(', ')}`);
                    discoveries.push(`Read symbol "${symbolName}" from "${targetPath}"`);
                } else if (toolName === 'search_workspace_regex') {
                    const matchCount = (toolResultContent.match(/\n/g) || []).length;
                    discoveries.push(`Search "${toolArgs.pattern}": ${matchCount} match(es) found`);
                } else if (toolName === 'list_directory_tree') {
                    const fileMatches = [...toolResultContent.matchAll(/([^\s]+\.\w+)/g)].map(m => m[1]);
                    if (fileMatches.length > 0) {
                        discoveries.push(`Directory "${targetPath || '.'}" contains: ${fileMatches.slice(0, 15).join(', ')}`);
                    }
                }
                
                // Display the tool's return value in the UI
                const safeOutput = toolResultContent.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const resultMessage = `<tool_execution><summary><span class="summary-text">↳ Output <span style="opacity:0.7; font-size:0.9em; font-weight:normal;">(⏱️ ${toolDuration}s)</span></span></summary><div class="details-content"><pre style="max-height: 250px; overflow-y: auto; font-size: 0.85em; background: var(--vscode-editor-background); padding: 8px; border-radius: 4px;"><code>${safeOutput}</code></pre></div></tool_execution>`;
                if (ui.addMessage) ui.addMessage(resultMessage, false);

                totalToolCalls++;

                if (totalToolCalls > this.MAX_TOOL_CALLS) {
                    currentPrompt += `\n\n[System Warning]: You used ${this.MAX_TOOL_CALLS} tool calls. Output <FINAL_PLAN> NOW.`;
                }
            } else {
                // Actor returned text instead of a tool call
                const hasPlan = data.content.includes('<FINAL_PLAN>');
                if (!hasPlan) {
                    // Actor failed to call a tool or output a plan — count as error retry, not budget
                    currentPrompt += `\n\n[System Error]: Actor Agent failed to call a tool or output a plan. It output plain text:\n${data.content}\nError: You must either call a tool or output <FINAL_PLAN>...</FINAL_PLAN>.`;
                    errorRetries++;
                    if (errorRetries > MAX_ERROR_RETRIES) break;
                    continue;
                }

                // Actor output the plan!
                const match = data.content.match(/<FINAL_PLAN>([\s\S]*?)<\/FINAL_PLAN>/);
                const plan = match ? match[1].trim() : data.content;

                ui.removeLoading();
                ui.addStep('📝', 'Plan Ready', feedback ? 'Plan re-drafted' : 'Implementation plan drafted');

                const contextSummary = ReActPlanner.buildContextSummary(collectedFiles, toolHistory, reasoningHistory, discoveries);
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
        const filePath = args.relative_path || '.';

        if (toolName === 'list_directory_tree') {
            const depth = args.depth ? ` (depth ${args.depth})` : '';
            return { icon: '📂', action: 'list_directory_tree', detail: `${filePath}${depth}` };
        }
        if (toolName === 'read_full_file') {
            return { icon: '📄', action: 'read_full_file', detail: `${filePath}` };
        }
        if (toolName === 'read_file_chunk') {
            const lines = (args.start_line && args.end_line)
                ? ` (lines ${args.start_line}-${args.end_line})`
                : '';
            return { icon: '📄', action: 'read_file_chunk', detail: `${filePath}${lines}` };
        }
        if (toolName === 'search_workspace_regex') {
            const scope = filePath !== '.' ? ` in ${filePath}` : '';
            return { icon: '🔍', action: 'search_workspace_regex', detail: `"${args.pattern}"${scope}` };
        }
        if (toolName === 'analyze_large_file') {
            return { icon: '🧠', action: 'analyze_large_file', detail: `${filePath}` };
        }
        if (toolName === 'deep_dive_symbol') {
            return { icon: '🕵️', action: 'deep_dive_symbol', detail: `${args.symbol_name} in ${filePath}` };
        }
        return { icon: '🔧', action: toolName, detail: JSON.stringify(args).substring(0, 80) };
    }

    /**
     * Builds a context summary for the Critic to verify against.
     */
    private static buildContextSummary(collectedFiles: string[], toolHistory: ToolResponse[], reasoningHistory: string[], discoveries: string[] = []): string {
        const parts: string[] = [];

        if (collectedFiles.length > 0) {
            const uniqueFiles = [...new Set(collectedFiles)];
            parts.push(`## Files Read\n${uniqueFiles.map(f => `- ${f}`).join('\n')}`);
        }

        if (discoveries.length > 0) {
            parts.push(`## Confirmed Facts (extracted during exploration)\n${discoveries.map((d, i) => `${i + 1}. ${d}`).join('\n')}`);
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
     * Small models often emit JSON blobs or <function=...> wrappers instead of native tool calls.
     * Handles all 6 planning tools: list_directory_tree, read_full_file,
     * read_file_chunk, search_workspace_regex, analyze_large_file, deep_dive_symbol.
     */
    private static tryParseInlineToolCall(content: string): AIResponse | null {
        if (content.includes('<FINAL_PLAN>')) { return null; }

        // Fix A: Parse <function=tool_name>{json}</function> format (common hallucination from small models)
        const funcMatch = content.match(/<function=(\w+)>\s*(\{[\s\S]*?\})\s*<\/function>/);
        if (funcMatch) {
            try {
                const toolName = funcMatch[1];
                const args = JSON.parse(funcMatch[2]);
                // Map hallucinated tool names to real ones
                const nameMap: Record<string, string> = {
                    'analyze_function': 'deep_dive_symbol',
                    'read_file': 'read_full_file',
                    'search': 'search_workspace_regex',
                    'list_dir': 'list_directory_tree',
                };
                const resolvedName = nameMap[toolName] || toolName;
                return { type: 'tool_call', tool_name: resolvedName, arguments: args };
            } catch {}
        }

        // Standard JSON blob parsing
        const matches = content.match(/\{[^{}]{5,500}\}/g);
        if (!matches) { return null; }

        for (const match of matches) {
            try {
                const args = JSON.parse(match);

                // search_workspace_regex
                if (typeof args.pattern === 'string') {
                    return { type: 'tool_call', tool_name: 'search_workspace_regex', arguments: args };
                }
                // deep_dive_symbol (most specific — requires both symbol_name and relative_path)
                if (typeof args.symbol_name === 'string' && typeof args.relative_path === 'string') {
                    return { type: 'tool_call', tool_name: 'deep_dive_symbol', arguments: args };
                }
                // analyze_large_file
                if (typeof args.relative_path === 'string' && args.analyze === true) {
                    return { type: 'tool_call', tool_name: 'analyze_large_file', arguments: args };
                }
                // read_file_chunk
                if (typeof args.relative_path === 'string' && typeof args.start_line === 'number' && typeof args.end_line === 'number') {
                    return { type: 'tool_call', tool_name: 'read_file_chunk', arguments: args };
                }
                // read_full_file vs list_directory_tree — disambiguate by depth field
                if (typeof args.relative_path === 'string') {
                    if (typeof args.depth === 'number') {
                        return { type: 'tool_call', tool_name: 'list_directory_tree', arguments: args };
                    }
                    return { type: 'tool_call', tool_name: 'read_full_file', arguments: args };
                }
            } catch { continue; }
        }
        return null;
    }
}
