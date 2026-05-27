/**
 * Lane 3 — Multi-Agent Orchestrator (Risky / Large Tasks)
 * 
 * Simplified pipeline using the ReAct pattern (like Codex/Cursor):
 * 
 *   ReAct Planner  → Single agent that reads, reasons, reads more, then plans
 *   Critic         → Reviews plan against exploration context (max 2 retries)
 *   Human-in-Loop  → Final approval UI
 *   Handoff        → Lane 2 Execution Flow
 * 
 * The ReAct Planner uses progressive deepening:
 *   Level 1: Wide scan (project structure)
 *   Level 2: Identify targets (configs, entry points)
 *   Level 3: Assess scope (read key files)
 *   Level 4: Extract behaviors (grep for patterns)
 *   Level 5: Fill gaps (read remaining sections)
 *   Level 6: Draft plan (with exact identifiers from code)
 */

import { ILaneStrategy } from './ILaneStrategy';
import { ChatMessage } from '../../types/schemas';
import { IAgentUI } from '../AgentExecutor';
import { Lane2Execution } from './Lane2Execution';

import { ReActPlanner } from './lane3/ReActPlanner';
import { CriticAgent } from './lane3/CriticAgent';

export class Lane3Risky implements ILaneStrategy {
    constructor(
        private ui: IAgentUI,
        private workspacePath: string,
        private lane2Fallback: Lane2Execution
    ) {}

    async execute(prompt: string, model: string, history: ChatMessage[], settings?: any): Promise<string> {
        const criticModel = settings?.l2Model || model;

        try {
            // ─── Phase 1: ReAct Planning ─────────────────────────────────
            this.ui.statusUpdate?.('ReAct Planner: Exploring codebase...');
            let { plan, contextSummary } = await ReActPlanner.plan(
                prompt, model, history, this.workspacePath, this.ui
            );

            // Show the drafted plan to the user
            if (this.ui.addMessage) {
                this.ui.addMessage("### 📋 Drafted Implementation Plan\n\n" + plan, false);
            }

            // ─── Phase 2: Critic Review Loop (max 2 retries) ─────────────
            let criticPassed = false;
            let criticRetries = 0;
            let lastCriticFeedback = '';

            while (!criticPassed && criticRetries < CriticAgent.MAX_CRITIC_RETRIES) {
                this.ui.statusUpdate?.(`Critic review (attempt ${criticRetries + 1}/${CriticAgent.MAX_CRITIC_RETRIES})...`);
                const criticResult = await CriticAgent.review(
                    plan, contextSummary, prompt, criticModel, history, this.ui
                );

                if (criticResult.approved) {
                    criticPassed = true;
                } else {
                    criticRetries++;
                    lastCriticFeedback = criticResult.feedback || 'Plan has issues.';

                    if (criticRetries < CriticAgent.MAX_CRITIC_RETRIES) {
                        // Re-plan with Critic feedback — the ReAct Planner can
                        // fetch additional files on the re-draft pass
                        this.ui.statusUpdate?.('ReAct Planner: Re-drafting based on Critic feedback...');
                        const revised = await ReActPlanner.plan(
                            prompt, model, history, this.workspacePath, this.ui, lastCriticFeedback
                        );
                        plan = revised.plan;
                        contextSummary = revised.contextSummary;

                        if (this.ui.addMessage) {
                            this.ui.addMessage("### 🔄 Revised Plan (Critic Feedback)\n\n" + plan, false);
                        }
                    }
                }
            }

            // Force-escalate if Critic never approved
            if (!criticPassed) {
                this.ui.addStep('⚠️', 'Critic', `Force-escalating after ${CriticAgent.MAX_CRITIC_RETRIES} failed reviews`);
                if (this.ui.addMessage) {
                    this.ui.addMessage(
                        `> ⚠️ **Warning:** The automated Critic could not approve this plan after ${CriticAgent.MAX_CRITIC_RETRIES} attempts.\n> Last feedback: ${lastCriticFeedback}\n> Please review carefully before approving.`,
                        false
                    );
                }
            }

            // ─── Phase 3: Human-in-the-Loop Approval ─────────────────────
            this.ui.removeLoading();
            this.ui.addStep('⏸️', 'Approval', 'Waiting for human review');
            this.ui.statusUpdate?.('Waiting for plan approval...');

            const approved = await this.ui.askPlanApproval(plan);

            if (!approved) {
                this.ui.addStep('❌', 'Approval', 'Plan rejected by human');
                return "Plan rejected. Please modify your request or provide specific feedback, and I will re-draft a safer plan.";
            }

            this.ui.addStep('✅', 'Approval', 'Plan approved by human');

            // ─── Phase 4: Handoff to Lane 2 Execution ────────────────────
            this.ui.statusUpdate?.('Executing approved plan...');
            return await this.lane2Fallback.runExecutionFlow(prompt, plan, model, history, []);

        } catch (error: any) {
            console.error('[Lattice Lane3] Pipeline error:', error);
            this.ui.removeLoading();
            this.ui.addStep('❌', 'Error', error.message || 'Pipeline failed');
            return `Lane 3 pipeline error: ${error.message}. Please try again or simplify the request.`;
        }
    }
}
