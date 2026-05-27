import { ChatMessage, ChatRequest } from '../types/schemas';
import { ModelFactory } from '../models/ModelFactory';

/**
 * Lattice L0 Router — Two-Step LLM Routing
 * 
 * Instead of asking the LLM to output a single classification word (which weak
 * models frequently get wrong), we force chain-of-thought reasoning:
 * 
 *   Step 1 (Analyze): The LLM must first write a brief analysis of the task —
 *                      how many files? New or existing? What scope?
 *   Step 2 (Classify): Based on its own analysis, it outputs the lane.
 * 
 * This dramatically improves accuracy because the model "thinks" before deciding.
 */
export class Router {

    static async classify(prompt: string, history: ChatMessage[], model: string = 'gemini'): Promise<'chat' | 'code_edit' | 'LANE_3'> {

        const systemInstruction = `
You are a task complexity analyzer for an AI coding assistant.

Your job: analyze the user's request and classify it into the correct lane.

## STEP 1 — ANALYZE (you MUST write this first)

Think through these questions:
- Does the request involve creating NEW files/folders/projects, or modifying EXISTING ones?
- How many files will likely be touched? (1-2 = small, 3+ = large)
- Does it involve a framework migration, redesign, or rebuild?
- Is it just a question or conversation?

Write your analysis in 2-3 sentences inside <ANALYSIS>...</ANALYSIS> tags.

## STEP 2 — CLASSIFY (output this AFTER your analysis)

Based on your analysis, output EXACTLY one of these inside <LANE>...</LANE> tags:

- "chat" — Questions, explanations, conversation. No file changes needed.
  Examples: "what is a closure?", "explain hooks", "how does X work?"

- "code_edit" — Small modifications to 1-2 EXISTING files. Bug fixes, styling changes, adding a button.
  Examples: "fix the bug in auth.js", "change the button color", "add error handling"

- "LANE_3" — ANY of these signals mean LANE_3:
  • Creating a NEW project, folder, or app from scratch
  • Redesigning, rebuilding, or rewriting a module or system  
  • Working across 3+ files or creating new architecture
  • Framework migration (e.g. "in react", "to typescript", "using vue")
  • Setting up a new folder structure
  • Any task that needs a plan before execution
  Examples: "redesign frontend in react", "create a new app", "build frontend-react", 
            "scaffold a backend", "migrate to TypeScript", "rewrite the auth system"

IMPORTANT: When in doubt between "code_edit" and "LANE_3", ALWAYS choose "LANE_3". 
It is safer to plan first than to blindly edit files.

## OUTPUT FORMAT

<ANALYSIS>Your 2-3 sentence analysis here</ANALYSIS>
<LANE>your_classification</LANE>
`.trim();

        const request: ChatRequest = {
            prompt: `User Request: "${prompt}"`,
            model: model,
            workspace: '',
            tool_history: [],
            chat_history: history.length > 0 ? history.slice(-4) : [],  // Last 2 exchanges for context
        };

        try {
            const response = await ModelFactory.generateWithFallback(request, systemInstruction);
            if (response.type === 'message') {
                const content = response.content;

                // Log the analysis for debugging
                const analysisMatch = content.match(/<ANALYSIS>([\s\S]*?)<\/ANALYSIS>/i);
                if (analysisMatch) {
                    console.log(`[Lattice Router] Analysis: ${analysisMatch[1].trim()}`);
                }

                // Extract the lane classification
                const laneMatch = content.match(/<LANE>\s*(chat|code_edit|LANE_3)\s*<\/LANE>/i);
                if (laneMatch) {
                    const lane = laneMatch[1].trim();
                    if (lane.toLowerCase() === 'lane_3') {
                        return 'LANE_3';
                    } else if (lane.toLowerCase() === 'code_edit') {
                        return 'code_edit';
                    } else if (lane.toLowerCase() === 'chat') {
                        return 'chat';
                    }
                }

                // Fallback: check for keywords anywhere in the response
                const lower = content.toLowerCase();
                if (lower.includes('lane_3')) {
                    return 'LANE_3';
                } else if (lower.includes('code_edit')) {
                    return 'code_edit';
                } else if (lower.includes('chat')) {
                    return 'chat';
                }
            }
        } catch (e) {
            console.error('[Lattice Router] Classification failed, defaulting to LANE_3:', e);
            return 'LANE_3';
        }

        // If response was completely unparseable, default to LANE_3 (safest)
        console.warn('[Lattice Router] Could not parse LLM response, defaulting to LANE_3');
        return 'LANE_3';
    }
}
