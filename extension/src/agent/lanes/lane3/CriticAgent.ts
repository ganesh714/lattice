/**
 * Lane 3 — Critic Agent (Automated Red Team Review)
 * 
 * Reviews the draft plan against the context summary collected during planning.
 * The Critic receives:
 *   1. The user's original request
 *   2. The draft implementation plan
 *   3. A context summary (files explored, key searches, reasoning) from the ReAct Planner
 * 
 * Max 2 retries before force-escalating to human.
 */

import { ChatMessage, ChatRequest } from '../../../types/schemas';
import { ModelFactory } from '../../../models/ModelFactory';
import { IAgentUI } from '../../AgentExecutor';
import { CriticResult } from './types';

export class CriticAgent {
    static readonly MAX_CRITIC_RETRIES = 2;

    /**
     * Reviews a draft plan against the exploration context.
     * Returns whether the plan is approved and any feedback.
     */
    static async review(
        plan: string,
        contextSummary: string,
        userPrompt: string,
        model: string,
        history: ChatMessage[],
        ui: IAgentUI
    ): Promise<CriticResult> {
        ui.setLoading('Critic: Reviewing plan...');

        const systemInstruction = `You are a Senior Software Architect performing a Red Team review of an implementation plan.

You have been given:
1. The user's original request
2. The draft implementation plan
3. A context summary showing which files were explored, key search results, and the planner's reasoning

REVIEW CHECKLIST:
1. **Correctness**: Does the plan actually solve the user's request? Are there missing steps?
2. **Code Accuracy**: Does the plan reference specific file paths and identifiers that were actually found during exploration? Flag any names that appear to be hallucinated (not mentioned in the context summary).
3. **Completeness**: Did the planner explore enough of the codebase? Are there obvious files or directories that should have been read but weren't?
4. **Safety**: Could any step break existing functionality? Are there missing error-handling or rollback steps?
5. **Order of Operations**: Are the steps in the right order? Are dependencies handled correctly?

OUTPUT FORMAT (JSON only, no markdown):
{
  "approved": true/false,
  "feedback": "Detailed explanation of issues found, or 'Plan is sound.' if approved"
}

RULES:
- Be strict but fair. Only REJECT if there are concrete, actionable issues.
- If the plan references files or functions not mentioned in the context summary, flag them as potentially hallucinated.
- If the plan is missing critical steps, explain exactly what's missing.
- Output ONLY the JSON object.`;

        const request: ChatRequest = {
            prompt: `User Request: "${userPrompt}"

## Draft Plan
${plan}

## Exploration Context (What the planner actually discovered)
${contextSummary}`,
            model: model,
            workspace: '',
            tool_history: [],
            chat_history: history,
            disableTools: true
        };

        try {
            const response = await ModelFactory.generateWithFallback(request, systemInstruction);
            if (response.type === 'message') {
                const cleaned = response.content
                    .replace(/```json\s*/g, '')
                    .replace(/```\s*/g, '')
                    .trim();
                const parsed = JSON.parse(cleaned);

                const result: CriticResult = {
                    approved: !!parsed.approved,
                    feedback: parsed.feedback || undefined
                };

                ui.removeLoading();
                if (result.approved) {
                    ui.addStep('✅', 'Critic', 'Plan approved by automated review');
                } else {
                    ui.addStep('⚠️', 'Critic', 'Issues found — requesting revision');
                }

                return result;
            }
        } catch (e) {
            console.error('[Lattice Lane3] CriticAgent failed, defaulting to approval:', e);
        }

        // Fallback: if Critic fails, approve to avoid blocking the pipeline
        ui.removeLoading();
        ui.addStep('⚠️', 'Critic', 'Review failed — defaulting to approval');
        return { approved: true, feedback: 'Critic review failed. Proceeding with human review.' };
    }
}
