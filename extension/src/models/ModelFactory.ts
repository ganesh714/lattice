import * as vscode from 'vscode';
import { IAIProvider } from "../types/schemas";
import { GeminiClient } from "./GeminiClient";
import { GroqClient } from "./GroqClient";
import { OllamaClient } from "./OllamaClient";
import { ChatRequest, AIResponse } from "../types/schemas";

const llmTraceChannel = vscode.window.createOutputChannel("Lattice LLM Trace");

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

        console.log(`[Lattice ModelFactory] Starting execution flow.`);
        console.log(`[Lattice ModelFactory] Requested model: "${request.model}"`);
        console.log(`[Lattice ModelFactory] Resolved provider list to attempt (primary first, then configured fallbacks):`, finalProviders);

        let primaryError: any = null;
        for (const providerType of finalProviders) {
            try {
                console.log(`[Lattice ModelFactory] Attempting provider "${providerType}"...`);
                
                llmTraceChannel.appendLine(`\n========== NEW LLM CALL (${providerType}) ==========`);
                llmTraceChannel.appendLine(`Model: ${request.model}`);
                llmTraceChannel.appendLine(`System Instruction:\n${systemInstruction}`);
                llmTraceChannel.appendLine(`Prompt:\n${request.prompt}`);
                if (request.tool_history && request.tool_history.length > 0) {
                    llmTraceChannel.appendLine(`Tool History: ${request.tool_history.length} items`);
                }
                llmTraceChannel.appendLine(`====================================================\n`);

                const provider = this.getProvider(providerType);
                const response = await provider.generateResponse(request, systemInstruction);
                console.log(`[Lattice ModelFactory] Provider "${providerType}" successfully generated a response! Response type: "${response.type}"`);
                
                llmTraceChannel.appendLine(`\n<<<<<<<<<< LLM RESPONSE (${providerType}) <<<<<<<<<<`);
                if (response.type === 'message') {
                    llmTraceChannel.appendLine(response.content);
                } else if (response.type === 'tool_call') {
                    llmTraceChannel.appendLine(`TOOL CALL: ${response.tool_name}`);
                    llmTraceChannel.appendLine(`ARGUMENTS:\n${JSON.stringify(response.arguments, null, 2)}`);
                }
                llmTraceChannel.appendLine(`<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n`);

                return response;
            } catch (error: any) {
                console.error(`[Lattice ModelFactory] Provider "${providerType}" failed! Error details:`, error.message || error);
                
                llmTraceChannel.appendLine(`\n[ERROR] LLM CALL FAILED: ${error.message}`);
                
                if (error.stack) {
                    console.error(`[Lattice ModelFactory] Stack trace:`, error.stack);
                }
                if (!primaryError) {
                    primaryError = error;
                }
                continue;
            }
        }

        console.error(`[Lattice ModelFactory] All attempted providers failed.`);
        throw primaryError || new Error("All configured AI providers failed to generate a response.");
    }
}
