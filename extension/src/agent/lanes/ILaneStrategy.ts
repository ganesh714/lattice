import { ChatMessage } from '../../types/schemas';

export interface ILaneStrategy {
    execute(prompt: string, model: string, history: ChatMessage[], settings?: any): Promise<string>;
}
