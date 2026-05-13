import * as vscode from 'vscode';
import { LatticeChatProvider } from './providers/LatticeChatProvider';
import { OnnxClient } from './models/OnnxClient';

/**
 * Lattice Extension Entry Point
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('[Lattice] Extension is now active!');

    // Eagerly initialize the L0 Router Worker Thread
    OnnxClient.init(context.extensionUri);

    // Register the Sidebar Chat Provider
    const provider = new LatticeChatProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LatticeChatProvider.viewType, provider)
    );
}

export function deactivate() {
    console.log('[Lattice] Extension is deactivating...');
}
