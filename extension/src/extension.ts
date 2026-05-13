import * as vscode from 'vscode';
import { LatticeChatProvider } from './providers/LatticeChatProvider';

/**
 * Lattice Extension Entry Point
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('Lattice is now active!');

    // Register the Sidebar Chat Provider
    const provider = new LatticeChatProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LatticeChatProvider.viewType, provider)
    );
}

export function deactivate() {
    console.log('Lattice is deactivating...');
}
