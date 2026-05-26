/**
 * Lane 3 — Step 0: Task Decomposer
 * 
 * A single, lightweight LLM call that converts a vague user prompt into a
 * structured SearchPlan. This gives Agent 1 (Context Reader) explicit guidance
 * on WHAT to search for instead of guessing blindly.
 * 
 * Example:
 *   Input:  "improve the performance of our API"
 *   Output: { search_terms: ["cache", "database", "query", "setTimeout"],
 *             likely_dirs: ["src/api/", "src/services/", "src/db/"],
 *             key_entities: ["ApiController", "DatabaseService"] }
 */

import { ChatMessage, ChatRequest } from '../../../types/schemas';
import { ModelFactory } from '../../../models/ModelFactory';
import { SearchPlan } from './types';

export class TaskDecomposer {

    /**
     * Decomposes a user prompt into a structured search plan.
     * This is a single LLM call with no tools — fast and cheap.
     */
    static async decompose(prompt: string, history: ChatMessage[], model: string): Promise<SearchPlan> {
        const systemInstruction = `You are a code search strategist. Your job is to analyze a developer's request and produce a precise search plan for exploring a codebase.

Given the user's request, output a JSON object with exactly these fields:
- "search_terms": an array of 3-8 keywords/patterns to grep for in the codebase (function names, class names, variable names, API endpoints, error messages mentioned in the request)
- "likely_dirs": an array of 1-5 directory paths most likely to contain relevant code (use common conventions like "src/", "lib/", "services/", "components/", "routes/", "models/")
- "key_entities": an array of specific class names, function names, or variable names explicitly mentioned or strongly implied by the request

RULES:
1. search_terms should be concrete code identifiers, NOT vague English words. Prefer "handleLogin" over "authentication logic".
2. likely_dirs should use relative paths with forward slashes.
3. If the user mentions specific files or paths, include them in likely_dirs.
4. Output ONLY the JSON object. No markdown, no explanation.`;

        const request: ChatRequest = {
            prompt: `User Request: "${prompt}"`,
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
                return {
                    search_terms: Array.isArray(parsed.search_terms) ? parsed.search_terms : [],
                    likely_dirs: Array.isArray(parsed.likely_dirs) ? parsed.likely_dirs : ['.'],
                    key_entities: Array.isArray(parsed.key_entities) ? parsed.key_entities : []
                };
            }
        } catch (e) {
            console.error('[Lattice Lane3] TaskDecomposer failed, using fallback:', e);
        }

        // Fallback: extract simple keywords from the prompt itself
        return TaskDecomposer.fallbackDecompose(prompt);
    }

    /**
     * Fallback when the LLM call fails: extract keywords directly from the prompt.
     */
    private static fallbackDecompose(prompt: string): SearchPlan {
        const words = prompt
            .replace(/[^a-zA-Z0-9_\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3)
            .filter(w => !['this', 'that', 'with', 'from', 'have', 'been', 'will', 'should', 'could', 'would', 'want', 'need', 'make', 'like'].includes(w.toLowerCase()));

        // Deduplicate and take top 6
        const uniqueTerms = [...new Set(words)].slice(0, 6);

        return {
            search_terms: uniqueTerms.length > 0 ? uniqueTerms : ['function', 'class', 'export'],
            likely_dirs: ['.'],
            key_entities: []
        };
    }
}
