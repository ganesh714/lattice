/**
 * Lane 3 — Agent 2: Architecture Extractor
 * 
 * Receives raw code chunks from Agent 1 and extracts a structured ArchitectureMap.
 * This is a pure text-processing LLM call — NO tools needed.
 * 
 * CRITICAL: This agent extracts EXACT code identifiers (function signatures,
 * interface definitions, import paths). It does NOT paraphrase into plain English.
 * This ensures the downstream Planner and Critic can verify real variable names.
 */

import { ChatMessage, ChatRequest } from '../../../types/schemas';
import { ModelFactory } from '../../../models/ModelFactory';
import { IAgentUI } from '../../AgentExecutor';
import { ArchitectureMap, FileArchitecture } from './types';

export class ArchExtractorAgent {

    /**
     * Extracts a structured architecture map from raw code chunks.
     * Returns an ArchitectureMap with per-file breakdowns and dependency chains.
     */
    static async extract(
        rawCodeChunks: string[],
        model: string,
        history: ChatMessage[],
        ui: IAgentUI
    ): Promise<ArchitectureMap> {
        ui.setLoading('Agent 2: Extracting architecture...');

        const systemInstruction = `You are a code architecture analyzer. Your job is to extract the EXACT structure of the provided code into a JSON architecture map.

For each file in the code chunks, extract:
- "filePath": the file path as shown in the chunk header
- "exports": array of exported function, class, and interface NAMES (exact identifiers only)
- "imports": array of raw import statements (verbatim)
- "interfaces": array of full interface/type definitions (copy them EXACTLY as written in the code, do not paraphrase)
- "keyVariables": array of important const/let/var declarations with their type annotations (e.g., "const MAX_RETRIES: number = 3")

Also extract:
- "dependencies": array of cross-file dependency chains you discover (e.g., "Lane3Risky → Lane2Execution → FileSystemTools")

CRITICAL RULES:
1. Extract EXACT code identifiers. Do NOT rename, abbreviate, or paraphrase anything.
2. Copy interface definitions VERBATIM from the source code.
3. If a file has no exports or interfaces, use empty arrays.
4. Output ONLY the JSON object. No markdown fences, no explanation.

Output format:
{
  "files": [ { "filePath": "...", "exports": [...], "imports": [...], "interfaces": [...], "keyVariables": [...] } ],
  "dependencies": [...]
}`;

        const codePayload = rawCodeChunks.join('\n\n---\n\n');

        const request: ChatRequest = {
            prompt: `Extract the architecture map from these code chunks:\n\n${codePayload}`,
            model: model,
            workspace: '',
            tool_history: [],
            chat_history: history,
            disableTools: true
        };

        try {
            const response = await ModelFactory.generateWithFallback(request, systemInstruction);
            if (response.type === 'message') {
                const cleaned = response.content
                    .replace(/```json\s*/g, '')
                    .replace(/```\s*/g, '')
                    .trim();
                const parsed = JSON.parse(cleaned);

                const architectureMap: ArchitectureMap = {
                    files: Array.isArray(parsed.files)
                        ? parsed.files.map((f: any) => ({
                            filePath: f.filePath || '',
                            exports: Array.isArray(f.exports) ? f.exports : [],
                            imports: Array.isArray(f.imports) ? f.imports : [],
                            interfaces: Array.isArray(f.interfaces) ? f.interfaces : [],
                            keyVariables: Array.isArray(f.keyVariables) ? f.keyVariables : []
                        } as FileArchitecture))
                        : [],
                    dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : []
                };

                ui.removeLoading();
                ui.addStep('🏗️', 'Architecture', `Mapped ${architectureMap.files.length} files`);
                return architectureMap;
            }
        } catch (e) {
            console.error('[Lattice Lane3] ArchExtractorAgent failed:', e);
        }

        // Fallback: return a minimal architecture map from the raw chunks
        ui.removeLoading();
        ui.addStep('⚠️', 'Architecture', 'Extraction failed, using raw context');
        return ArchExtractorAgent.fallbackExtract(rawCodeChunks);
    }

    /**
     * Fallback extraction when the LLM fails: parse file paths from chunk headers.
     */
    private static fallbackExtract(rawCodeChunks: string[]): ArchitectureMap {
        const files: FileArchitecture[] = rawCodeChunks.map(chunk => {
            const pathMatch = chunk.match(/\[File:\s*(.+?)\]/);
            return {
                filePath: pathMatch ? pathMatch[1].trim() : 'unknown',
                exports: [],
                imports: [],
                interfaces: [],
                keyVariables: []
            };
        });

        return { files, dependencies: [] };
    }
}
