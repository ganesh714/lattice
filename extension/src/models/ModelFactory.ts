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

    static isProviderConfigured(providerType: string): boolean {
        const config = vscode.workspace.getConfiguration('lattice');
        switch (providerType.toLowerCase()) {
            case 'gemini':
                return !!config.get<string>('apiKeys.gemini');
            case 'groq':
            case 'grok':
                return !!config.get<string>('apiKeys.groq');
            case 'ollama':
                return !!config.get<string>('local.ollamaEndpoint');
            default:
                return false;
        }
    }

    static async generateWithFallback(request: ChatRequest, systemInstruction: string): Promise<AIResponse> {
        const selectedModel = request.model.toLowerCase();
        let providersToTry = ['gemini', 'groq', 'ollama'];
        
        // Prioritize selected model
        const primaryProvider = providersToTry.find(p => selectedModel.includes(p)) || 'gemini';
        providersToTry = providersToTry.filter(p => p !== primaryProvider);
        
        // Only include fallback providers if they are configured
        const configuredFallbacks = providersToTry.filter(p => this.isProviderConfigured(p));
        const finalProviders = [primaryProvider, ...configuredFallbacks];

        let primaryError: any = null;
        for (const providerType of finalProviders) {
            try {
                const provider = this.getProvider(providerType);
                return await provider.generateResponse(request, systemInstruction);
            } catch (error) {
                console.error(`Provider ${providerType} failed:`, error);
                if (!primaryError) {
                    primaryError = error;
                }
                continue;
            }
        }

        throw primaryError || new Error("All configured AI providers failed to generate a response.");
    }
}
