import { ILaneStrategy } from './ILaneStrategy';
import { ChatMessage } from '../../types/schemas';
import { IAgentUI } from '../AgentExecutor';
import { Lane2Execution } from './Lane2Execution';

export class Lane3Risky implements ILaneStrategy {
    constructor(
        private ui: IAgentUI,
        private workspacePath: string,
        private lane2Fallback: Lane2Execution
    ) {}

    async execute(prompt: string, model: string, history: ChatMessage[], settings?: any): Promise<string> {
        const planModel = model; // For lane 3, plan generation uses the primary model
        const criticModel = settings?.l2Model || model;

        this.ui.setLoading("Architecting risky plan...");
        const plan = await this.lane2Fallback.createReviewedPlan(prompt, history, planModel, criticModel);

        this.ui.removeLoading();
        this.ui.addStep('⏸️', 'Approval', 'Waiting for plan approval');
        
        const approved = await this.ui.askPlanApproval(plan);
        if (!approved) {
            this.ui.addStep('❌', 'Approval', 'Plan rejected');
            return "Plan rejected. Modify the request or send revised instructions, and I will draft a safer plan.";
        }
        
        this.ui.addStep('✅', 'Approval', 'Plan approved');

        // Execute via Lane 2 flow once approved
        return await this.lane2Fallback.runExecutionFlow(prompt, plan, model, history, []);
    }
}
