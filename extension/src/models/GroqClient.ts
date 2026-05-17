import { ChatRequest, AIResponse, IAIProvider } from "../types/schemas";
import { LATTICE_TOOLS } from "../tools/ToolRegistry";

export class GroqClient implements IAIProvider {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async generateResponse(request: ChatRequest, systemInstruction: string): Promise<AIResponse> {
        const Groq = require("groq-sdk");
        const groq = new Groq({ apiKey: this.apiKey });

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

        // 3. Add tool history
        // Groq/OpenAI format requires assistant messages with tool_calls followed by tool messages
        for (const toolRes of request.tool_history) {
            const toolCallId = `call_${Math.random().toString(36).substring(7)}`;
            messages.push({
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: toolCallId,
                    type: "function",
                    function: {
                        name: toolRes.tool_name,
                        arguments: JSON.stringify(toolRes.arguments)
                    }
                }]
            });
            messages.push({
                role: "tool",
                tool_call_id: toolCallId,
                name: toolRes.tool_name,
                content: toolRes.content
            });
        }

        let modelName = "llama-3.3-70b-versatile";
        if (request.model) {
            if (request.model.startsWith("groq:")) {
                modelName = request.model.substring(5);
            } else if (!request.model.includes(":")) {
                const lowerModel = request.model.toLowerCase();
                if (lowerModel.includes("groq") || lowerModel.includes("llama") || lowerModel.includes("mixtral") || lowerModel.includes("gemma")) {
                    modelName = request.model;
                }
            }
        }

        const completion = await groq.chat.completions.create({
            messages: messages,
            model: modelName,
            tools: LATTICE_TOOLS.map(t => ({
                type: "function",
                function: t
            })),
            tool_choice: "auto",
        });

        const responseMessage = completion.choices[0].message;

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            const call = responseMessage.tool_calls[0].function;
            return {
                type: "tool_call",
                tool_name: call.name,
                arguments: JSON.parse(call.arguments)
            };
        }

        return {
            type: "message",
            content: responseMessage.content || ""
        };
    }
}
