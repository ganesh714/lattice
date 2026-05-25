import * as vscode from 'vscode';
import { ChatMessage } from '../types/schemas';
import { Router } from './Router';
import { Critic } from './Critic';
import { PromptSanitizer } from '../tools/Security';
import { Lane1Chat } from './lanes/Lane1Chat';
import { Lane2Execution } from './lanes/Lane2Execution';
import { Lane3Risky } from './lanes/Lane3Risky';

type ExecutionIntent = 'chat' | 'code_edit' | 'LANE_3';

export interface IAgentUI {
    addStep(icon: string, action: string, target: string): void;
    setLoading(text: string): void;
    removeLoading(): void;
    askApproval(target: string, oldText: string, newText: string): Promise<boolean>;
    askPlanApproval(plan: string): Promise<boolean>;
    statusUpdate?(text: string): void;
    addMessage?(text: string, isUser: boolean): void;
}

export class AgentExecutor {
    // Keep snapshots empty for now or track globally if needed by UI
    getChatHistorySnapshot(): ChatMessage[] { return []; }
    getToolHistorySnapshot(): any[] { return []; }

    constructor(
        private ui: IAgentUI,
        private workspacePath: string
    ) {}

    async execute(prompt: string, model: string, history: ChatMessage[], settings?: any): Promise<string> {
        // Phase 1: Security pre-check and Intent Routing (L0)
        this.ui.setLoading("Running security checks...");
        const sanitize = PromptSanitizer.check(prompt);
        let intent: ExecutionIntent;

        if (sanitize.blocked) {
            intent = 'LANE_3';
            this.ui.addStep('⚠️', 'Risk Check', `Lane 3: ${sanitize.matches.join(', ')}`);
            this.ui.statusUpdate?.('Dangerous prompt detected; routing to Lane 3...');
        } else {
            this.ui.setLoading("Classifying intent...");
            this.ui.statusUpdate?.('Routing intent (L0)...');
            intent = await Router.classify(prompt, history, model);
            let intentStr = 'Chat Path (Lane 1)';
            if (intent === 'code_edit') intentStr = 'Work Path (Lane 2)';
            else if (intent === 'LANE_3') intentStr = 'Risky Path (Lane 3)';
            this.ui.addStep('🧠', 'Routing', intentStr);
        }

        // Initialize Strategies
        const lane2 = new Lane2Execution(this.ui, this.workspacePath);
        const lane1 = new Lane1Chat(this.ui, this.workspacePath, lane2);
        const lane3 = new Lane3Risky(this.ui, this.workspacePath, lane2);

        let finalResponse: string = '';

        const needsActiveFileContext = this.needsActiveFileContext(prompt);

        if (intent === 'chat') {
            finalResponse = await lane1.execute(prompt, model, history, settings);
        } else if (intent === 'code_edit' && needsActiveFileContext) {
            finalResponse = await lane1.execute(prompt, model, history, settings);
        } else if (intent === 'code_edit') {
            finalResponse = await lane2.execute(prompt, model, history, settings);
        } else if (intent === 'LANE_3') {
            finalResponse = await lane3.execute(prompt, model, history, settings);
        }

        // Phase 5: Memory pruning — let L2 Critic compress long histories
        try {
            const CHAT_THRESHOLD = 10;
            if (history.length > CHAT_THRESHOLD) {
                const l2Model = settings?.l2Model || model;
                this.ui.setLoading('L2 Critic is compressing session memory...');
                this.ui.addStep('🗜️', 'Compressing', 'L2 Critic');

                const summary = await Critic.compressSession(history, [], l2Model); 
                
                const lastUser = [...history].reverse().find(m => m.role === 'user');
                history.length = 0;
                history.push({ role: 'system', text: summary });
                if (lastUser) history.push(lastUser);

                this.ui.removeLoading();
                this.ui.addStep('✅', 'Compressed', 'Session memory compressed');
            }
        } catch (e) {
            console.error('[Lattice] Memory pruning failed:', e);
        }

        return finalResponse;
    }

    private needsActiveFileContext(prompt: string): boolean {
        const normalized = prompt.toLowerCase();
        const referencesActiveFile =
            /\b(this|current|active|opened|open)\s+file\b/.test(normalized) ||
            /\bin\s+this\s+file\b/.test(normalized) ||
            /\b(this|current|active|opened|open)\s+(html|css|js|ts|tsx|jsx|py|java|go|rs|php|json|yaml|yml|xml|md)\b/.test(normalized);
        const referencesHere = /\b(here|this|current|above|below)\b/.test(normalized);
        const asksForInspection = /\b(what|where|which|show|find|read|explain|summarize|server\s+url|url|endpoint|port|api|localhost|host|base\s+url|fetch|axios|variable|function|class|const|let)\b/.test(normalized);
        const asksCodeFact = /\b(server\s+url|url|endpoint|port|api|localhost|host|base\s+url|fetch|axios|variable|function|class|const|let)\b/.test(normalized);
        return (referencesActiveFile && asksForInspection) || (referencesHere && asksCodeFact);
    }
}
