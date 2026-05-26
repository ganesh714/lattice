/**
 * Lane 3 — Agent 4: Critic (Automated Red Team Review)
 * 
 * Reviews the draft plan against the Architecture Map to verify:
 *   1. Correctness — Does the plan solve the user's request?
 *   2. SOLID Principles — Does it follow best practices?
 *   3. Safety — Does it avoid breaking existing functionality?
 * 
 * Fixes Issue #1 (Blind Critic): Receives BOTH the plan AND the Architecture Map
 * so it can verify that function names, interfaces, and imports are real.
 * 
 * Fixes Issue #3 (No Loop Limit): Max 2 retries before force-escalating to human.
 */

import { ChatMessage, ChatRequest } from '../../../types/schemas';
import { ModelFactory } from '../../../models/ModelFactory';
import { IAgentUI } from '../../AgentExecutor';
import { ArchitectureMap, CriticResult } from './types';

export class CriticAgent {
    static readonly MAX_CRITIC_RETRIES = 2;

    /**
     * Reviews a draft plan against the architecture map.
     * Returns whether the plan is approved and any feedback.
     */
    static async review(
        plan: string,
        architectureMap: ArchitectureMap,
        userPrompt: string,
        model: string,
        history: ChatMessage[],
        ui: IAgentUI
    ): Promise<CriticResult> {
        ui.setLoading('Agent 4: Reviewing plan...');

        // Serialize architecture map for the Critic
        const archSummary = architectureMap.files.map(f => {
            const parts = [`File: ${f.filePath}`];
            if (f.exports.length > 0) { parts.push(`  Exports: ${f.exports.join(', ')}`); }
            if (f.interfaces.length > 0) { parts.push(`  Interfaces: ${f.interfaces.join('; ')}`); }
            if (f.keyVariables.length > 0) { parts.push(`  Vars: ${f.keyVariables.join(', ')}`); }
            return parts.join('\n');
        }).join('\n\n');

        const depsText = architectureMap.dependencies.length > 0
            ? `\nDependency Chains: ${architectureMap.dependencies.join(', ')}`
            : '';

        const systemInstruction = `You are a Senior Software Architect performing a Red Team review of an implementation plan.

You have been given:
1. The user's original request
2. The draft implementation plan
3. The verified Architecture Map (exact exports, imports, interfaces from the actual codebase)

REVIEW CHECKLIST:
1. **Correctness**: Does the plan actually solve the user's request? Are there missing steps?
2. **Code Accuracy**: Does the plan reference REAL function names, class names, and file paths from the Architecture Map? Flag any names that do NOT appear in the Architecture Map — they are likely hallucinated.
3. **SOLID Principles**: Does the plan follow Single Responsibility, Open/Closed, etc.?
4. **Safety**: Could any step break existing functionality? Are there missing rollback or error-handling steps?
5. **Completeness**: Are all necessary files covered? Does the plan miss any imports or dependency updates?

OUTPUT FORMAT (JSON only, no markdown):
{
  "approved": true/false,
  "feedback": "Detailed explanation of issues found, or 'Plan is sound.' if approved"
}

RULES:
- Be strict. If the plan references a function name that doesn't exist in the Architecture Map, REJECT.
- If the plan is missing error handling for a critical operation, REJECT.
- If the plan is solid, APPROVE with a brief confirmation.
- Output ONLY the JSON object.`;

        const request: ChatRequest = {
            prompt: `User Request: "${userPrompt}"

## Draft Plan
${plan}

## Architecture Map (Verified from Codebase)
${archSummary}
${depsText}`,
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
