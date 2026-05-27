import { ChatMessage, ChatRequest } from '../types/schemas';
import { ModelFactory } from '../models/ModelFactory';

/**
 * Lattice L0 Router — Two-Stage Routing
 * 
 * Stage 1 (Fast Path): Deterministic keyword matching for unambiguous signals.
 *   - If the prompt contains strong LANE_3 signals (e.g. "redesign", "create new project",
 *     "scaffold", "migrate", "rebuild"), immediately return LANE_3 without an LLM call.
 *   - If the prompt is clearly a question or conversation, immediately return 'chat'.
 *
 * Stage 2 (LLM Path): For ambiguous cases, ask the LLM to classify.
 *   - This acts as a fallback for prompts not caught by the fast path.
 *
 * Why: LLMs (especially small/fast ones) frequently misclassify complex multi-file tasks
 * as code_edit. Deterministic rules ensure critical tasks always reach Lane 3.
 */
export class Router {

    // ── Stage 1: Deterministic keyword fast-path ────────────────────────────────
    private static readonly LANE_3_PATTERNS: RegExp[] = [
        // Creating new things from scratch
        /\b(create|build|scaffold|init|initialize|bootstrap|set up|setup)\b.{0,40}\b(project|app|application|frontend|backend|server|api|service|folder|directory)\b/i,
        // Redesign / rebuild / rewrite
        /\b(redesign|rebuild|rewrite|redo|refactor)\b.{0,40}\b(frontend|backend|app|application|system|project|entire|whole|all)\b/i,
        /\b(new folder|new directory|new project)\b/i,
        // Framework migrations
        /\b(migrate|migration|convert|port)\b.{0,60}\b(react|vue|angular|svelte|next|nuxt|vite|typescript|python|node|django|rails)\b/i,
        /\b(in react|in vue|in angular|in svelte|using react|using vue|with react)\b/i,
        // Delete/destroy operations
        /\b(delete|remove|wipe|destroy|drop)\b.{0,30}\b(folder|directory|database|table|all files)\b/i,
    ];

    private static readonly CHAT_PATTERNS: RegExp[] = [
        /^\s*(what|how|why|when|where|who|explain|describe|can you|could you|tell me|is it|are you|do you|should i)\b/i,
        /\b(what is|what are|how does|how do|why is|why does|explain|difference between)\b/i,
    ];

    private static fastPathClassify(prompt: string): 'chat' | 'code_edit' | 'LANE_3' | null {
        // Check strong Lane 3 signals first (higher priority)
        for (const pattern of this.LANE_3_PATTERNS) {
            if (pattern.test(prompt)) {
                console.log(`[Lattice Router] Fast-path → LANE_3 (matched: ${pattern})`);
                return 'LANE_3';
            }
        }

        // Check strong chat signals
        for (const pattern of this.CHAT_PATTERNS) {
            if (pattern.test(prompt)) {
                // Extra guard: even if it looks like a question, if there are action verbs, use LLM
                const hasActionVerbs = /\b(create|build|add|fix|edit|change|modify|update|delete|remove|refactor)\b/i.test(prompt);
                if (!hasActionVerbs) {
                    console.log(`[Lattice Router] Fast-path → chat (matched: ${pattern})`);
                    return 'chat';
                }
            }
        }

        return null; // Ambiguous — fall through to LLM
    }

    // ── Stage 2: LLM-based classification for ambiguous cases ───────────────────
    static async classify(prompt: string, history: ChatMessage[], model: string = 'gemini'): Promise<'chat' | 'code_edit' | 'LANE_3'> {
        // Stage 1: Fast deterministic path
        const fastResult = this.fastPathClassify(prompt);
        if (fastResult !== null) {
            return fastResult;
        }

        // Stage 2: LLM classification for ambiguous prompts
        const systemInstruction = `
You are a routing classifier for an AI coding assistant. Classify the user's request into EXACTLY one of three categories:

1. "chat" — Simple questions, explanations, general conversation, asking about concepts.
   Examples: "what is a closure?", "explain React hooks", "how does git rebase work?"

2. "code_edit" — Standard requests to read, modify, debug, or refactor existing code/files. Single-file or small-scope changes.
   Examples: "fix the bug in auth.js", "add a login button", "refactor this function", "change the color to blue"

3. "LANE_3" — High-risk or large-scope operations:
   - Creating a new project, new folder, or scaffolding an entire app from scratch
   - Redesigning, rebuilding, or rewriting an entire module/frontend/backend
   - Massive architectural refactoring across many files
   - Migrating an entire codebase to a new framework or language
   Examples: "create a react project", "redesign the frontend in vue", "scaffold a new backend", "migrate the app to TypeScript", "build a new frontend-react folder", "rewrite the app in python"

IMPORTANT: When in doubt between "code_edit" and "LANE_3", choose "LANE_3". It is always safer to plan before acting.

Respond with EXACTLY one word: "chat", "code_edit", or "LANE_3". Nothing else.
        `.trim();

        const request: ChatRequest = {
            prompt: `User Request: "${prompt}"`,
            model: model,
            workspace: '',
            tool_history: [],
            chat_history: [],
        };

        try {
            const response = await ModelFactory.generateWithFallback(request, systemInstruction);
            if (response.type === 'message') {
                const content = response.content.trim().toLowerCase();
                if (content.includes('lane_3')) {
                    return 'LANE_3';
                } else if (content.includes('code_edit')) {
                    return 'code_edit';
                } else if (content.includes('chat')) {
                    return 'chat';
                }
            }
        } catch (e) {
            console.error('[Lattice Router] LLM classification failed, defaulting to LANE_3:', e);
            // Default to LANE_3 (not code_edit) — safer to plan than to blindly execute
            return 'LANE_3';
        }

        // If LLM response was ambiguous, default to LANE_3 (safer than code_edit)
        return 'LANE_3';
    }
}
