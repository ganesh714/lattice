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
                const lowerModel = request.model.trim().toLowerCase();
                if (lowerModel !== "groq" && (lowerModel.includes("groq") || lowerModel.includes("llama") || lowerModel.includes("mixtral") || lowerModel.includes("gemma"))) {
                    modelName = request.model;
                }
            }
        }

        const payload: any = {
            messages: messages,
            model: modelName,
        };
        if (!request.disableTools) {
            let tools = LATTICE_TOOLS;
            if (request.allowedTools) {
                tools = tools.filter(t => request.allowedTools!.includes(t.name));
            }
            payload.tools = tools.map(t => ({
                type: "function",
                function: t
            }));
            payload.tool_choice = "auto";
        }

        let completion: any;
        try {
            completion = await groq.chat.completions.create(payload);
        } catch (error: any) {
            const recoveredToolCall = this.tryRecoverFailedToolCall(error);
            if (recoveredToolCall) {
                return recoveredToolCall;
            }
            throw error;
        }

        const responseMessage = completion.choices[0].message;

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            const call = responseMessage.tool_calls[0].function;
            // Capture any reasoning text the model output alongside the tool call
            const reasoning = responseMessage.content?.trim() || undefined;
            return {
                type: "tool_call",
                tool_name: call.name,
                arguments: JSON.parse(call.arguments),
                reasoning
            };
        }

        return {
            type: "message",
            content: responseMessage.content || ""
        };
    }

    private tryRecoverFailedToolCall(error: any): AIResponse | null {
        const failedGeneration = error?.error?.failed_generation || error?.failed_generation;
        if (typeof failedGeneration !== "string") {
            return null;
        }

        const match =
            failedGeneration.match(/<function=([a-zA-Z0-9_-]+)\(([\s\S]*?)\)<(?:\/)?function>/) ||
            failedGeneration.match(/<function=([a-zA-Z0-9_-]+)>\s*([\s\S]*?)\s*<(?:\/)?function>/);
        if (!match) {
            return null;
        }

        try {
            const toolName = match[1];
            const toolArgs = JSON.parse(match[2]);
            if (!LATTICE_TOOLS.some(tool => tool.name === toolName)) {
                return {
                    type: "message",
                    content: this.extractMessageFromFailedGeneration(failedGeneration, toolArgs)
                };
            }

            return {
                type: "tool_call",
                tool_name: toolName,
                arguments: toolArgs
            };
        } catch {
            return null;
        }
    }

    private extractMessageFromFailedGeneration(failedGeneration: string, toolArgs: Record<string, any>): string {
        if (typeof toolArgs.text === "string" && toolArgs.text.trim()) {
            return toolArgs.text.trim();
        }

        const withoutFunctionCall = failedGeneration.replace(/<function=[\s\S]*?<\/?function>/g, "").trim();
        if (withoutFunctionCall) {
            return withoutFunctionCall;
        }

        return "The model attempted to call an unsupported tool instead of replying in plain text.";
    }
}
