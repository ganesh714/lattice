import { ChatRequest, AIResponse, IAIProvider } from "../types/schemas";
import { LATTICE_TOOLS } from "../tools/ToolRegistry";

export class OllamaClient implements IAIProvider {
    private baseUrl: string;

    constructor(baseUrl: string = "http://127.0.0.1:11434") {
        this.baseUrl = baseUrl;
    }

    async generateResponse(request: ChatRequest, systemInstruction: string): Promise<AIResponse> {
        const url = `${this.baseUrl}/api/chat`;
        
        const messages: any[] = [{ role: "system", content: systemInstruction }];

        // 1. Add chat history
        for (const msg of request.chat_history) {
            messages.push({
                role: msg.role === "user" ? "user" : "assistant",
                content: msg.text
            });
        }

        // 2. Add current prompt
        messages.push({ role: "user", content: request.prompt });

        // 3. Add tool history (simplified for Ollama)
        for (const toolRes of request.tool_history) {
            messages.push({
                role: "assistant",
                content: `Tool call: ${toolRes.tool_name}(${JSON.stringify(toolRes.arguments)})`
            });
            messages.push({
                role: "user",
                content: `Tool result: ${toolRes.content}`
            });
        }

        let modelName = "llama3";
        if (request.model) {
            if (request.model.startsWith("ollama:")) {
                modelName = request.model.substring(7);
            } else if (!request.model.includes(":")) {
                const lowerModel = request.model.toLowerCase();
                if (!lowerModel.includes("gemini") && !lowerModel.includes("groq")) {
                    modelName = request.model;
                }
            }
        }

        const payload = {
            model: modelName,
            messages: messages,
            stream: false,
            tools: LATTICE_TOOLS.map(t => ({
                type: "function",
                function: t
            }))
        };

        // Resolve a fetch implementation at runtime. Prefer globalThis.fetch (Node 18+/browsers),
        // otherwise try to dynamically import 'node-fetch'. Provide a clear error if unavailable.
        let fetchImpl: any = (globalThis as any).fetch;
        if (!fetchImpl) {
            try {
                const nodeFetch = await import('node-fetch');
                fetchImpl = nodeFetch.default || nodeFetch;
            } catch (e) {
                throw new Error('fetch is not available in this environment. Install "node-fetch" or run on Node 18+.');
            }
        }

        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Ollama Error: ${await response.text()}`);
        }

        const data = await response.json();
        const message = data.message;

        if (message.tool_calls && message.tool_calls.length > 0) {
            const call = message.tool_calls[0].function;
            return {
                type: "tool_call",
                tool_name: call.name,
                arguments: call.arguments
            };
        }

        return {
            type: "message",
            content: message.content || ""
        };
    }
}
