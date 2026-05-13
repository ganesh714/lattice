import { ModelFactory } from '../models/ModelFactory';
import { ChatMessage } from '../types/schemas';

/**
 * Lattice L0 Router
 * Logic for intent classification (Work Path vs Chat Path)
 */
export class Router {
    static async classify(prompt: string, history: ChatMessage[]): Promise<'chat' | 'code_edit'> {
        const systemInstruction = `
            Classify the user's latest message into one of two categories:
            1. 'chat': Simple questions, explanations, or general conversation.
            2. 'code_edit': Requests to add, modify, delete, or refactor code/files.
            
            Respond with ONLY the category name.
        `;

        const request = {
            prompt: `Message: "${prompt}"`,
            model: 'groq', // Use fast model for routing
            workspace: '',
            tool_history: [],
            chat_history: history
        };

        try {
            const response = await ModelFactory.generateWithFallback(request, systemInstruction);
            if (response.type === 'message') {
                const category = response.content.toLowerCase().trim();
                return category.includes('code_edit') ? 'code_edit' : 'chat';
            }
        } catch (e) {
            console.error("Routing failed, defaulting to chat:", e);
        }
        return 'chat';
    }
}
