/**
 * Lane 3 — Multi-Agent Orchestrator (Risky / Large Tasks)
 * 
 * Coordinates the 4-agent sequential pipeline for high-risk or large code changes:
 * 
 *   Step 0: TaskDecomposer    → Prompt → SearchPlan
 *   Agent 1: ContextReader    → SearchPlan → Raw Code Chunks
 *   Agent 2: ArchExtractor    → Raw Chunks → Architecture Map
 *   Agent 3: Planner          → SharedContextBundle → Draft Plan (has read-only tools)
 *   Agent 4: Critic           → Plan + ArchMap → Approve/Reject (max 2 retries)
 *   Human-in-the-Loop         → Final approval UI
 *   Handoff                   → Lane 2 Execution Flow
 * 
 * Issue fixes applied:
 *   #1 (Blind Critic)       — Critic receives both plan AND architecture map
 *   #2 (No feedback loop)   — Planner has read-only tool access on re-drafts
 *   #3 (No loop limit)      — Max 2 Critic retries, then force-escalate to human
 *   #4 (Blind Agent 1)      — TaskDecomposer gives Agent 1 a structured search plan
 */

import { ILaneStrategy } from './ILaneStrategy';
import { ChatMessage } from '../../types/schemas';
import { IAgentUI } from '../AgentExecutor';
import { Lane2Execution } from './Lane2Execution';

import { TaskDecomposer } from './lane3/TaskDecomposer';
import { ContextReaderAgent } from './lane3/ContextReaderAgent';
import { ArchExtractorAgent } from './lane3/ArchExtractorAgent';
import { PlannerAgent } from './lane3/PlannerAgent';
import { CriticAgent } from './lane3/CriticAgent';
import { SharedContextBundle } from './lane3/types';

export class Lane3Risky implements ILaneStrategy {
    constructor(
        private ui: IAgentUI,
        private workspacePath: string,
        private lane2Fallback: Lane2Execution
    ) {}

    async execute(prompt: string, model: string, history: ChatMessage[], settings?: any): Promise<string> {
        const criticModel = settings?.l2Model || model;

        try {
            // ─── Step 0: Task Decomposer ─────────────────────────────────
            this.ui.setLoading('Step 0: Decomposing task...');
            this.ui.statusUpdate?.('Decomposing task into search plan...');
            const searchPlan = await TaskDecomposer.decompose(prompt, history, model);
            this.ui.removeLoading();
            this.ui.addStep('🧩', 'Decompose', `${searchPlan.search_terms.length} search terms, ${searchPlan.likely_dirs.length} dirs`);

            // ─── Agent 1: Context Reader ─────────────────────────────────
            this.ui.statusUpdate?.('Agent 1: Gathering context...');
            const rawCodeChunks = await ContextReaderAgent.gatherContext(
                searchPlan, this.workspacePath, model, history, this.ui
            );

            // ─── Agent 2: Architecture Extractor ─────────────────────────
            this.ui.statusUpdate?.('Agent 2: Extracting architecture...');
            const architectureMap = await ArchExtractorAgent.extract(
                rawCodeChunks, model, history, this.ui
            );

            // ─── Build Shared Context Bundle ─────────────────────────────
            const bundle: SharedContextBundle = {
                rawCodeChunks,
                architectureMap,
                userPrompt: prompt,
                searchPlan
            };

            // ─── Agent 3 + Agent 4: Planner-Critic Loop ─────────────────
            let plan = await PlannerAgent.draft(bundle, model, history, this.workspacePath, this.ui);

            // Show the drafted plan to the user
            if (this.ui.addMessage) {
                this.ui.addMessage("### 📋 Drafted Implementation Plan\n\n" + plan, false);
            }

            // Critic review loop (max 2 retries)
            let criticPassed = false;
            let criticRetries = 0;
            let lastCriticFeedback = '';

            while (!criticPassed && criticRetries < CriticAgent.MAX_CRITIC_RETRIES) {
                this.ui.statusUpdate?.(`Agent 4: Critic review (attempt ${criticRetries + 1}/${CriticAgent.MAX_CRITIC_RETRIES})...`);
                const criticResult = await CriticAgent.review(
                    plan, architectureMap, prompt, criticModel, history, this.ui
                );

                if (criticResult.approved) {
                    criticPassed = true;
                } else {
                    criticRetries++;
                    lastCriticFeedback = criticResult.feedback || 'Plan has issues.';

                    if (criticRetries < CriticAgent.MAX_CRITIC_RETRIES) {
                        // Re-draft with Critic feedback
                        this.ui.statusUpdate?.('Agent 3: Re-drafting plan based on Critic feedback...');
                        plan = await PlannerAgent.draft(
                            bundle, model, history, this.workspacePath, this.ui, lastCriticFeedback
                        );

                        if (this.ui.addMessage) {
                            this.ui.addMessage("### 🔄 Revised Plan (Critic Feedback)\n\n" + plan, false);
                        }
                    }
                }
            }

            // If Critic never approved after max retries, force-escalate with warning
            if (!criticPassed) {
                this.ui.addStep('⚠️', 'Critic', `Force-escalating after ${CriticAgent.MAX_CRITIC_RETRIES} failed reviews`);
                if (this.ui.addMessage) {
                    this.ui.addMessage(
                        `> ⚠️ **Warning:** The automated Critic could not approve this plan after ${CriticAgent.MAX_CRITIC_RETRIES} attempts.\n> Last feedback: ${lastCriticFeedback}\n> Please review carefully before approving.`,
                        false
                    );
                }
            }

            // ─── Human-in-the-Loop Approval ──────────────────────────────
            this.ui.removeLoading();
            this.ui.addStep('⏸️', 'Approval', 'Waiting for human review');
            this.ui.statusUpdate?.('Waiting for plan approval...');

            const approved = await this.ui.askPlanApproval(plan);

            if (!approved) {
                this.ui.addStep('❌', 'Approval', 'Plan rejected by human');
                return "Plan rejected. Please modify your request or provide specific feedback, and I will re-draft a safer plan.";
            }

            this.ui.addStep('✅', 'Approval', 'Plan approved by human');

            // ─── Handoff to Lane 2 Execution ─────────────────────────────
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
