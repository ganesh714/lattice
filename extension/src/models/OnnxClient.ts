import { ChatRequest, AIResponse, IAIProvider } from "../types/schemas";

/**
 * Placeholder for L0 Router using ONNX Runtime Web.
 * To be implemented in Phase 5.
 */
export class OnnxClient implements IAIProvider {
    async generateResponse(request: ChatRequest, systemInstruction: string): Promise<AIResponse> {
        // TODO: Implement ONNX inference for fast intent classification
        return {
            type: "message",
            content: "OnnxClient is not yet implemented. Falling back to primary models."
        };
    }
}
