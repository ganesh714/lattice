import { Worker } from 'worker_threads';
import * as vscode from 'vscode';
import { ModelFactory } from './ModelFactory';

export class OnnxClient {
    private static worker: Worker | null = null;
    private static initialized = false;
    private static pendingRequests = new Map<string, { resolve: (val: string) => void, reject: (err: any) => void }>();

    static async init(extensionUri: vscode.Uri) {
        if (this.initialized) return;
        
        try {
            // Note: In production compiled extensions, the path to the worker JS file needs to be evaluated relative to out/
            const workerPath = vscode.Uri.joinPath(extensionUri, 'out', 'models', 'OnnxWorker.js').fsPath;
            const modelPath = vscode.Uri.joinPath(extensionUri, 'lattice_l0.onnx').fsPath;

            // Failsafe check if the worker file exists (important during dev vs production)
            const fs = require('fs');
            if (!fs.existsSync(workerPath)) {
                console.warn(`[Lattice] OnnxWorker not found at ${workerPath}. L0 Router will use fallback.`);
                return;
            }

            this.worker = new Worker(workerPath);
            
            this.worker.on('message', (msg) => {
                if (msg.type === 'init_success') {
                    this.initialized = true;
                    console.log('[Lattice] OnnxWorker initialized successfully.');
                } else if (msg.type === 'result') {
                    const req = this.pendingRequests.get(msg.id);
                    if (req) {
                        req.resolve(msg.intent);
                        this.pendingRequests.delete(msg.id);
                    }
                } else if (msg.type === 'error') {
                    if (msg.id) {
                        const req = this.pendingRequests.get(msg.id);
                        if (req) {
                            req.reject(new Error(msg.error));
                            this.pendingRequests.delete(msg.id);
                        }
                    } else {
                        console.error('[Lattice] OnnxWorker init error:', msg.error);
                    }
                }
            });

            this.worker.postMessage({ type: 'init', modelPath });
        } catch (e) {
            console.error('[Lattice] Failed to initialize OnnxWorker:', e);
        }
    }

    static async classifyIntent(prompt: string, fallbackModel: string): Promise<'chat' | 'code_edit'> {
        if (!this.initialized || !this.worker) {
            console.log('[Lattice] OnnxWorker not ready. Falling back to L1 Model for classification.');
            return this.fallbackClassify(prompt, fallbackModel);
        }

        const id = Math.random().toString(36).substring(7);
        return new Promise<'chat' | 'code_edit'>((resolve) => {
            // Set a 500ms timeout. If ONNX fails to respond, fallback to ensure UI fluidity.
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                console.log('[Lattice] OnnxWorker timed out. Falling back to L1.');
                resolve(this.fallbackClassify(prompt, fallbackModel));
            }, 500);

            this.pendingRequests.set(id, {
                resolve: (intent) => {
                    clearTimeout(timeout);
                    resolve(intent as 'chat' | 'code_edit');
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    console.log('[Lattice] OnnxWorker failed:', err.message, 'Falling back to L1.');
                    resolve(this.fallbackClassify(prompt, fallbackModel));
                }
            });

            this.worker!.postMessage({ type: 'classify', prompt, id });
        });
    }

    private static async fallbackClassify(prompt: string, fallbackModel: string): Promise<'chat' | 'code_edit'> {
        const systemInstruction = `
            Classify the user's latest message into one of two categories:
            1. 'chat': Simple questions, explanations, or general conversation.
            2. 'code_edit': Requests to add, modify, delete, or refactor code/files.
            Respond with ONLY the category name.
        `;

        const request: any = {
            prompt: `Message: "${prompt}"`,
            model: fallbackModel, 
            workspace: '',
            tool_history: [],
            chat_history: []
        };

        try {
            const response = await ModelFactory.generateWithFallback(request, systemInstruction);
            if (response.type === 'message') {
                const category = response.content.toLowerCase().trim();
                return category.includes('code_edit') ? 'code_edit' : 'chat';
            }
        } catch (e) {
            console.error("[Lattice] Fallback routing failed, defaulting to chat:", e);
        }
        return 'chat';
    }
}
