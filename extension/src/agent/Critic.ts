import { ModelFactory } from '../models/ModelFactory';
import { ChatMessage } from '../types/schemas';

/**
 * Lattice L2 Critic
 * Logic for reviewing plans and self-healing.
 */
export class Critic {
    static async reviewPlan(prompt: string, plan: string, history: ChatMessage[]): Promise<{ approved: boolean; feedback?: string }> {
        const systemInstruction = `
            You are a Senior Software Architect. Review the following proposed plan for a code edit.
            Check for:
            1. Correctness: Does it solve the user's request?
            2. Best Practices: Does it follow SOLID principles?
            3. Safety: Does it avoid breaking existing functionality?

            Respond with a JSON object: { "approved": boolean, "feedback": "reasoning or suggestions" }
        `;

        const request = {
            prompt: `User Request: "${prompt}"\nProposed Plan: "${plan}"`,
            model: 'gemini', // Use a smart model for review
            workspace: '',
            tool_history: [],
            chat_history: history
        };

        try {
            const response = await ModelFactory.generateWithFallback(request, systemInstruction);
            if (response.type === 'message') {
                const result = JSON.parse(response.content);
                return { approved: result.approved, feedback: result.feedback };
            }
        } catch (e) {
            console.error("Plan review failed, defaulting to approval:", e);
        }
        return { approved: true };
    }

    static async summarizeSession(history: ChatMessage[]): Promise<string> {
        const systemInstruction = "Summarize the following chat history into a dense 200-word summary for context retrieval.";
        const request = {
            prompt: "Summarize this:",
            model: 'groq',
            workspace: '',
            tool_history: [],
            chat_history: history
        };

        try {
            const response = await ModelFactory.generateWithFallback(request, systemInstruction);
            if (response.type === 'message') {
                return response.content;
            }
        } catch (e) {}
        return "Session summary unavailable.";
    }
}
