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
        
        const model = genAI.getGenerativeModel({
            model: request.model.includes("gemini") ? request.model : "gemini-1.5-flash",
            systemInstruction: systemInstruction,
            tools: [{ functionDeclarations: LATTICE_TOOLS }]
        });

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

        const result = await model.generateContent({ contents });
        const response = await result.response;
        
        // Check for function calls
        const functionCalls = response.functionCalls();
        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            return {
                type: "tool_call",
                tool_name: call.name,
                arguments: call.args as Record<string, any>
            };
        }

        return {
            type: "message",
            content: response.text()
        };
    }
}
