import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentExecutor, IAgentUI } from '../agent/AgentExecutor';
import { ChatMessage } from '../types/schemas';
import { McpClient } from '../tools/McpClient';

export class LatticeChatProvider implements vscode.WebviewViewProvider, IAgentUI {
    public static readonly viewType = 'lattice.chatView';

    private _view?: vscode.WebviewView;
    private _chatHistory: ChatMessage[] = [];
    private _pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();
    private _pendingPlanApprovals = new Map<string, { resolve: (approved: boolean) => void }>();
    private _executor?: AgentExecutor;
    private _diffContents = new Map<string, string>();
    private _diffProviderRegistration?: vscode.Disposable;
    private _pendingDiffUris = new Map<string, string>();
    private _debugInterval?: NodeJS.Timeout;
    private _isCancelled = false;
    
    // Settings storage
    private _settings: {
        geminiApi?: string;
        groqApi?: string;
        ollamaUrl?: string;
        l1Model?: string;
        l2Model?: string;
        availableModels?: { gemini: string[]; groq: string[]; ollama: string[] };
    } = {};

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('lattice.mcp.servers')) {
                const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                try {
                    await McpClient.initialize(workspacePath, this);
                } catch (err: any) {
                    console.error("[Lattice] Failed to reload MCP servers on config change:", err);
                }
            }
        });
    }

    private ensureDiffProvider() {
        if (this._diffProviderRegistration) return;
        const provider: vscode.TextDocumentContentProvider = {
            provideTextDocumentContent: (uri: vscode.Uri) => {
                return this._diffContents.get(uri.toString()) || '';
            }
        };
        this._diffProviderRegistration = vscode.workspace.registerTextDocumentContentProvider('lattice-diff', provider);
    }

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

    statusUpdate(text: string) {
        this._view?.webview.postMessage({ type: 'statusUpdate', value: text });
    }

    addMessage(text: string, isUser: boolean = false) {
        this._view?.webview.postMessage({ type: 'addMessage', text, isUser });
    }

    sendMcpStatusUpdate() {
        const statuses = McpClient.getServersStatus();
        this._view?.webview.postMessage({ type: 'mcpStatusUpdate', servers: statuses });
    }

    getSettings() {
        return this._settings;
    }

    isCancelled() {
        return this._isCancelled;
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

        // Also register a diff provider and open a VS Code diff view for safe review
        try {
            this.ensureDiffProvider();
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            const absolutePath = path.isAbsolute(target) ? target : path.join(workspacePath, target);
            const diffUri = vscode.Uri.parse(`lattice-diff:${encodeURIComponent(absolutePath)}`);
            // Store the proposed content keyed by the diffUri
            this._diffContents.set(diffUri.toString(), newText);
            this._pendingDiffUris.set(id, diffUri.toString());

            // Open the native diff view: original file vs. proposed content
            await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(absolutePath), diffUri, `Lattice Proposal: ${path.basename(absolutePath)}`);
            // Auto-focus the proposed side of the diff so the user is directed to review it
            try {
                const doc = await vscode.workspace.openTextDocument(diffUri);
                await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
            } catch (e) {
                // If focusing fails, ignore — diff is still open
            }
        } catch (e) {
            console.error('Failed to open diff view:', e);
        }

        return new Promise<boolean>((resolve) => {
            this._pendingApprovals.set(id, { resolve });
        });
    }

    async askPlanApproval(plan: string): Promise<boolean> {
        const id = `plan_${Date.now()}`;
        this._view?.webview.postMessage({
            type: 'request_plan_approval',
            id,
            plan
        });

        return new Promise<boolean>((resolve) => {
            this._pendingPlanApprovals.set(id, { resolve });
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
            if (message.type === 'ready') {
                // Load settings from VS Code config and send to Webview
                const config = vscode.workspace.getConfiguration('lattice');
                this._settings = {
                    geminiApi: config.get<string>('apiKeys.gemini') || '',
                    groqApi: config.get<string>('apiKeys.groq') || '',
                    ollamaUrl: config.get<string>('local.ollamaEndpoint') || 'http://127.0.0.1:11434',
                    l1Model: config.get<string>('models.l1Model') || '',
                    l2Model: config.get<string>('models.l2Model') || '',
                    availableModels: config.get<any>('models.availableModels') || {}
                };
                webviewView.webview.postMessage({ type: 'initSettings', settings: this._settings });
                
                // Initialize MCP Client
                const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                McpClient.initialize(workspacePath, this).then(() => {
                    this.sendMcpStatusUpdate();
                }).catch(e => {
                    console.error("[Lattice] McpClient failed to initialize:", e);
                });
            } else if (message.type === 'prompt') {
                // Lazily create a persistent executor for the session
                const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                if (!this._executor) this._executor = new AgentExecutor(this, workspacePath);
                await this.handlePrompt(message.text, message.model);
            } else if (message.type === 'updateSettings') {
                // Store settings from the webview
                this._settings = message.settings || {};
                console.log('[Lattice] Settings updated:', this._settings);

                // Write keys to VS Code configuration so they persist and are accessible to ModelFactory and other clients
                try {
                    const config = vscode.workspace.getConfiguration('lattice');
                    if (this._settings.geminiApi !== undefined) {
                        config.update('apiKeys.gemini', this._settings.geminiApi, vscode.ConfigurationTarget.Global);
                    }
                    if (this._settings.groqApi !== undefined) {
                        config.update('apiKeys.groq', this._settings.groqApi, vscode.ConfigurationTarget.Global);
                    }
                    if (this._settings.ollamaUrl !== undefined) {
                        config.update('local.ollamaEndpoint', this._settings.ollamaUrl, vscode.ConfigurationTarget.Global);
                    }
                    if (this._settings.l1Model !== undefined) {
                        config.update('models.l1Model', this._settings.l1Model, vscode.ConfigurationTarget.Global);
                    }
                    if (this._settings.l2Model !== undefined) {
                        config.update('models.l2Model', this._settings.l2Model, vscode.ConfigurationTarget.Global);
                    }
                    if (this._settings.availableModels !== undefined) {
                        config.update('models.availableModels', this._settings.availableModels, vscode.ConfigurationTarget.Global);
                    }
                } catch (e) {
                    console.error('Failed to update VS Code configuration:', e);
                }
            } else if (message.type === 'approveEdit' || message.type === 'rejectEdit') {
                const pending = this._pendingApprovals.get(message.id);
                if (pending) {
                    pending.resolve(message.type === 'approveEdit');
                    this._pendingApprovals.delete(message.id);
                    // Cleanup diff content and close any open lattice-diff editors
                    const diffUriStr = this._pendingDiffUris.get(message.id);
                    if (diffUriStr) {
                        this._pendingDiffUris.delete(message.id);
                        this._diffContents.delete(diffUriStr);
                        // Close only editors that match the specific diff URI
                        for (const editor of vscode.window.visibleTextEditors) {
                            try {
                                if (editor.document.uri.toString() === diffUriStr) {
                                    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
                                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                                }
                            } catch (e) {
                                // ignore
                            }
                        }
                    }
                }
            } else if (message.type === 'approvePlan' || message.type === 'rejectPlan') {
                const pending = this._pendingPlanApprovals.get(message.id);
                if (pending) {
                    pending.resolve(message.type === 'approvePlan');
                    this._pendingPlanApprovals.delete(message.id);
                }
            } else if (message.type === 'addMcpServer') {
                try {
                    const config = vscode.workspace.getConfiguration('lattice');
                    const settingsServers = config.get<any>('mcp.servers') || {};
                    const updatedServers = {
                        ...settingsServers,
                        [message.name]: {
                            command: message.command,
                            args: message.args || [],
                            env: message.env || {}
                        }
                    };
                    await config.update('mcp.servers', updatedServers, vscode.ConfigurationTarget.Global);
                    console.log(`[Lattice] Added MCP Server ${message.name}`);
                } catch (e: any) {
                    console.error(`[Lattice] Failed to add MCP server:`, e);
                    vscode.window.showErrorMessage(`Failed to add MCP server: ${e.message}`);
                }
            } else if (message.type === 'removeMcpServer') {
                try {
                    const config = vscode.workspace.getConfiguration('lattice');
                    const settingsServers = { ...(config.get<any>('mcp.servers') || {}) };
                    delete settingsServers[message.name];
                    await config.update('mcp.servers', settingsServers, vscode.ConfigurationTarget.Global);
                    console.log(`[Lattice] Removed MCP Server ${message.name}`);
                } catch (e: any) {
                    console.error(`[Lattice] Failed to remove MCP server:`, e);
                    vscode.window.showErrorMessage(`Failed to remove MCP server: ${e.message}`);
                }
            } else if (message.type === 'abortGeneration') {
                this._isCancelled = true;
                console.log('[Lattice] User requested generation abort');
            }
        });

        // Start a periodic debug push to the webview to display executor internals
        this._debugInterval = setInterval(() => {
            try {
                if (this._executor) {
                    const chat = this._executor.getChatHistorySnapshot();
                    const tools = this._executor.getToolHistorySnapshot();
                    this._view?.webview.postMessage({ type: 'debugUpdate', chat_history: chat, tool_history: tools });
                }
            } catch (e) {
                // ignore
            }
        }, 1000);
    }

    private async handlePrompt(prompt: string, model: string) {
        if (!this._view) return;

        this._isCancelled = false; // Reset cancellation flag for new prompt

        // Use the persistent executor if available
        const executor = this._executor || new AgentExecutor(this, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');

        // Use L1 model from settings if available, otherwise use the passed model
        const l1Model = this._settings.l1Model || model || 'gemini';

        // 1. Setup UI
        this._view.webview.postMessage({ type: 'addMessage', text: prompt, isUser: true });
        this._view.webview.postMessage({ type: 'startBotMessage' });

        try {
            // 2. Run Executor (The Agentic Loop)
            const finalResponseText = await executor.execute(prompt, l1Model, this._chatHistory, this._settings);

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
        const webviewPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview');
        const htmlPath = path.join(webviewPath.fsPath, 'index.html');
        const cssPath = path.join(webviewPath.fsPath, 'style.css');
        const scriptPathOnDisk = vscode.Uri.joinPath(webviewPath, 'main.js');

        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const cssContent = fs.readFileSync(cssPath, 'utf8');
        const scriptUri = webview.asWebviewUri(scriptPathOnDisk);
        const nonce = this.getNonce();

        console.log('[Lattice Provider Debug] Script URI:', scriptUri.toString());
        console.log('[Lattice Provider Debug] Nonce:', nonce);
        console.log('[Lattice Provider Debug] CSP Source:', webview.cspSource);

        htmlContent = htmlContent.replace('{{inlineStyles}}', cssContent);
        htmlContent = htmlContent.replace(/{{scriptUri}}/g, scriptUri.toString());
        htmlContent = htmlContent.replace(/{{nonce}}/g, nonce);
        htmlContent = htmlContent.replace(/{{cspSource}}/g, webview.cspSource);

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
