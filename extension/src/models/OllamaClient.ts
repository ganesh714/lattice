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

        const payload = {
            model: request.model || "llama3",
            messages: messages,
            stream: false,
            tools: LATTICE_TOOLS.map(t => ({
                type: "function",
                function: t
            }))
        };

        const response = await fetch(url, {
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
