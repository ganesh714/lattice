/**
 * Lattice L0 Router
 * Logic for intent classification (Work Path vs Chat Path)
 */
export class Router {
    static async classify(prompt: string): Promise<'chat' | 'code_edit'> {
        // Placeholder for L0 logic. 
        // For now, assume everything is a code edit if it looks like one.
        return prompt.toLowerCase().includes('edit') || prompt.toLowerCase().includes('add') 
            ? 'code_edit' 
            : 'chat';
    }
}
