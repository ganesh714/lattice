export interface ToolResponse {
    tool_name: string;
    content: string;
    arguments: Record<string, any>;
}

export interface ChatMessage {
    role: 'user' | 'bot' | 'system';
    text: string;
}

export interface ChatRequest {
    prompt: string;
    model: string;
    workspace: string;
    tool_history: ToolResponse[];
    chat_history: ChatMessage[];
    disableTools?: boolean;
}

export interface ToolCall {
    type: 'tool_call';
    tool_name: string;
    arguments: Record<string, any>;
}

export interface TextResponse {
    type: 'message';
    content: string;
}

export type AIResponse = ToolCall | TextResponse;

export interface IAIProvider {
    generateResponse(request: ChatRequest, systemInstruction: string): Promise<AIResponse>;
}
