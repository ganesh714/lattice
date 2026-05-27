import { ChatMessage, ChatRequest } from '../types/schemas';
import { ModelFactory } from '../models/ModelFactory';

/**
 * Lattice L0 Router
 * Single-stage LLM-based intent classification into Lane 1 (Chat), Lane 2 (Code Edit), or Lane 3 (Risky).
 * Replaces the old two-stage ONNX stub + LLM approach with one accurate LLM call.
 */
export class Router {
    static async classify(prompt: string, history: ChatMessage[], model: string = 'gemini'): Promise<'chat' | 'code_edit' | 'LANE_3'> {
        const systemInstruction = `
You are a routing classifier for an AI coding assistant. Classify the user's request into EXACTLY one of three categories:

1. "chat" — Simple questions, explanations, general conversation, asking about concepts, or requests that don't involve modifying/creating files.
   Examples: "what is a closure?", "explain React hooks", "how does git rebase work?"

2. "code_edit" — Standard requests to read, modify, debug, or refactor existing code/files. Single-file or small-scope changes.
   Examples: "fix the bug in auth.js", "add a login button", "refactor this function", "change the color to blue"

3. "LANE_3" — High-risk or large-scope operations:
   - Creating a new project or scaffolding an entire app from scratch
   - Redesigning or rebuilding an entire module/frontend/backend
   - Massive architectural refactoring across many files
   - High-risk system commands (deleting directories, modifying system configs)
   - Migrating an entire codebase to a new framework/language
   Examples: "create a react project", "redesign the frontend in vue", "scaffold a new backend", "migrate the app to TypeScript", "build a new frontend-react folder"

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
            console.error('[Lattice Router] Classification failed, defaulting to code_edit:', e);
            // Default to code_edit instead of chat — safer to assume work intent than ignore it
            return 'code_edit';
        }

        // If response was ambiguous, default to code_edit (safer than chat)
        return 'code_edit';
    }
}
