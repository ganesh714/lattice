import { ChatRequest, AIResponse, IAIProvider } from "../types/schemas";
import { LATTICE_TOOLS } from "../tools/ToolRegistry";

export class GeminiClient implements IAIProvider {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async generateResponse(request: ChatRequest, systemInstruction: string): Promise<AIResponse> {
        // We will use a dynamic import or require for @google/generative-ai 
        // to avoid issues if it's not yet installed during early dev
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(this.apiKey);
        
        let modelName = "gemini-1.5-flash";
        if (request.model) {
            if (request.model.startsWith("gemini:")) {
                modelName = request.model.substring(7);
            } else if (request.model.includes("gemini") && !request.model.includes(":")) {
                if (request.model.trim().toLowerCase() !== "gemini") {
                    modelName = request.model;
                }
            }
        }

        const modelOptions: any = {
            model: modelName,
            systemInstruction: systemInstruction,
        };
        if (!request.disableTools) {
            let tools = LATTICE_TOOLS;
            if (request.allowedTools) {
                tools = tools.filter(tool => request.allowedTools!.includes(tool.name));
            }
            // Ensure tools are properly formatted for Gemini
            const formattedTools = tools.map(tool => ({
                name: tool.name,
                description: tool.description || "",
                inputSchema: {
                    type: tool.parameters.type || "object",
                    properties: tool.parameters.properties || {},
                    required: tool.parameters.required || []
                }
            }));
            modelOptions.tools = [{ functionDeclarations: formattedTools }];
        }
        const model = genAI.getGenerativeModel(modelOptions);

        const contents: any[] = [];
        
        // 1. Add chat history
        for (const msg of request.chat_history) {
            contents.push({
                role: msg.role === "user" ? "user" : "model",
                parts: [{ text: msg.text }]
            });
        }

        // 2. Add current prompt
        contents.push({
            role: "user",
            parts: [{ text: request.prompt }]
        });

        // 3. Add tool history
        // Gemini expects tool history in a specific sequence of Call -> Response
        for (const toolRes of request.tool_history) {
            contents.push({
                role: "model",
                parts: [{
                    functionCall: {
                        name: toolRes.tool_name,
                        args: toolRes.arguments
                    }
                }]
            });
            contents.push({
                role: "user",
                parts: [{
                    functionResponse: {
                        name: toolRes.tool_name,
                        response: { content: toolRes.content }
                    }
                }]
            });
        }

        try {
            const result = await model.generateContent({ contents });
            const response = await result.response;
            
            // Check for function calls
            const functionCalls = response.functionCalls();
            if (functionCalls && functionCalls.length > 0) {
                const call = functionCalls[0];
                // Capture any text/reasoning the model output alongside the tool call
                let reasoning: string | undefined;
                try {
                    const textContent = response.text();
                    if (textContent && textContent.trim()) {
                        reasoning = textContent.trim();
                    }
                } catch (_) {
                    // response.text() throws if there are no text parts — that's fine
                }
                return {
                    type: "tool_call",
                    tool_name: call.name,
                    arguments: call.args as Record<string, any>,
                    reasoning
                };
            }

            return {
                type: "message",
                content: response.text()
            };
        } catch (error: any) {
            console.error("[GeminiClient] API Error:", error);
            console.error("[GeminiClient] Model options:", JSON.stringify(modelOptions, null, 2));
            throw error;
        }
    }
}
