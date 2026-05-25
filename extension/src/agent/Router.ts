import { ChatMessage } from '../types/schemas';
import { OnnxClient } from '../models/OnnxClient';
import { ModelFactory } from '../models/ModelFactory';

/**
 * Lattice L0 Router
 * Logic for intent classification (Work Path vs Chat Path)
 */
export class Router {
    static async classify(prompt: string, history: ChatMessage[], model: string = 'gemini'): Promise<'chat' | 'code_edit' | 'LANE_3'> {
        // Use the OnnxClient (which wraps the Worker Thread) for ultra-fast local routing.
        const intent = await OnnxClient.classifyIntent(prompt, 'groq');
        
        if (intent === 'code_edit') {
            const systemInstruction = `
                Analyze if the user's request involves:
                1. Creating a new project or scaffolding an app from scratch
                2. Massive architectural refactoring
                3. High-risk system commands

                Respond with EXACTLY "LANE_3" if yes, or "code_edit" if it's a standard file edit/task.
            `;
            const request = {
                prompt: `User Request: "${prompt}"`,
                model: model, 
                workspace: '',
                tool_history: [],
                chat_history: []
            };

            try {
                const response = await ModelFactory.generateWithFallback(request, systemInstruction);
                if (response.type === 'message' && response.content.includes('LANE_3')) {
                    return 'LANE_3';
                }
            } catch (e) {
                // Ignore and fall through to code_edit
            }
        }
        
        return intent as 'chat' | 'code_edit' | 'LANE_3';
    }
}
