import * as vscode from 'vscode';
import { IAIProvider } from "../types/schemas";
import { GeminiClient } from "./GeminiClient";
import { GroqClient } from "./GroqClient";
import { OllamaClient } from "./OllamaClient";
import { ChatRequest, AIResponse } from "../types/schemas";

export class ModelFactory {
    static getProvider(modelType: string): IAIProvider {
        const config = vscode.workspace.getConfiguration('lattice');
        
        switch (modelType.toLowerCase()) {
            case 'gemini':
                const geminiKey = config.get<string>('apiKeys.gemini') || "";
                return new GeminiClient(geminiKey);
            case 'groq':
            case 'grok': // Support common typo
                const groqKey = config.get<string>('apiKeys.groq') || "";
                return new GroqClient(groqKey);
            case 'ollama':
                const ollamaUrl = config.get<string>('local.ollamaEndpoint') || "http://127.0.0.1:11434";
                return new OllamaClient(ollamaUrl);
            default:
                throw new Error(`Unsupported model provider: ${modelType}`);
        }
    }

    static async generateWithFallback(request: ChatRequest, systemInstruction: string): Promise<AIResponse> {
        const selectedModel = request.model.toLowerCase();
        let providersToTry = ['gemini', 'groq', 'ollama'];
        
        // Prioritize selected model
        const primaryProvider = providersToTry.find(p => selectedModel.includes(p)) || 'gemini';
        providersToTry = providersToTry.filter(p => p !== primaryProvider);
        providersToTry.unshift(primaryProvider);

        let lastError: any = null;
        for (const providerType of providersToTry) {
            try {
                const provider = this.getProvider(providerType);
                return await provider.generateResponse(request, systemInstruction);
            } catch (error) {
                console.error(`Provider ${providerType} failed:`, error);
                lastError = error;
                continue;
            }
        }

        throw lastError || new Error("All AI providers failed to generate a response.");
    }
}
