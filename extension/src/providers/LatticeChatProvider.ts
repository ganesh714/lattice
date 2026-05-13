import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentExecutor, IAgentUI } from '../agent/AgentExecutor';
import { ChatMessage } from '../types/schemas';

export class LatticeChatProvider implements vscode.WebviewViewProvider, IAgentUI {
    public static readonly viewType = 'lattice.chatView';

    private _view?: vscode.WebviewView;
    private _chatHistory: ChatMessage[] = [];
    private _pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    // --- IAgentUI Implementation ---
    addStep(icon: string, action: string, target: string) {
        this._view?.webview.postMessage({ type: 'addStep', icon, action, target });
    }

    setLoading(text: string) {
        this._view?.webview.postMessage({ type: 'setLoading', text });
    }

    removeLoading() {
        this._view?.webview.postMessage({ type: 'removeLoading' });
    }

    async askApproval(target: string, oldText: string, newText: string): Promise<boolean> {
        const id = `edit_${Date.now()}`;
        this._view?.webview.postMessage({
            type: 'askApproval',
            id,
            target,
            oldText,
            newText
        });

        return new Promise<boolean>((resolve) => {
            this._pendingApprovals.set(id, { resolve });
        });
    }
    // -------------------------------

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'prompt') {
                await this.handlePrompt(message.text, message.model);
            } else if (message.type === 'approveEdit' || message.type === 'rejectEdit') {
                const pending = this._pendingApprovals.get(message.id);
                if (pending) {
                    pending.resolve(message.type === 'approveEdit');
                    this._pendingApprovals.delete(message.id);
                }
            }
        });
    }

    private async handlePrompt(prompt: string, model: string) {
        if (!this._view) return;

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const executor = new AgentExecutor(this, workspacePath);

        // 1. Setup UI
        this._view.webview.postMessage({ type: 'addMessage', text: prompt, isUser: true });
        this._view.webview.postMessage({ type: 'startBotMessage' });

        try {
            // 2. Run Executor (The Agentic Loop)
            const finalResponseText = await executor.execute(prompt, model, this._chatHistory);

            // 3. Finalize UI
            this._view.webview.postMessage({ type: 'removeLoading' });
            this._view.webview.postMessage({ type: 'generationFinished' });
            this._view.webview.postMessage({ type: 'addMessage', text: finalResponseText, isUser: false });

            // 4. Update persistent history
            this._chatHistory.push({ role: 'user', text: prompt });
            this._chatHistory.push({ role: 'bot', text: finalResponseText });

        } catch (error: any) {
            console.error('Lattice Execution Error:', error);
            this._view.webview.postMessage({ type: 'removeLoading' });
            this._view.webview.postMessage({ type: 'generationFinished' });
            this._view.webview.postMessage({ type: 'addMessage', text: `Error: ${error.message}`, isUser: false, isError: true });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const webviewPath = path.join(this._extensionUri.fsPath, 'src', 'webview');
        const htmlPath = path.join(webviewPath, 'index.html');
        const cssPath = path.join(webviewPath, 'style.css');
        const scriptPathOnDisk = vscode.Uri.file(path.join(webviewPath, 'main.js'));

        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const cssContent = fs.readFileSync(cssPath, 'utf8');
        const scriptUri = webview.asWebviewUri(scriptPathOnDisk);
        const nonce = this.getNonce();

        htmlContent = htmlContent.replace('{{inlineStyles}}', cssContent);
        htmlContent = htmlContent.replace(/{{scriptUri}}/g, scriptUri.toString());
        htmlContent = htmlContent.replace(/{{nonce}}/g, nonce);

        return htmlContent;
    }

    private getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
