import { ChatMessage } from '../types/schemas';
import { OnnxClient } from '../models/OnnxClient';

/**
 * Lattice L0 Router
 * Logic for intent classification (Work Path vs Chat Path)
 */
export class Router {
    static async classify(prompt: string, history: ChatMessage[]): Promise<'chat' | 'code_edit'> {
        // Use the OnnxClient (which wraps the Worker Thread) for ultra-fast local routing.
        // Fallback to Groq if the ONNX model is missing or fails.
        return await OnnxClient.classifyIntent(prompt, 'groq');
    }
}
