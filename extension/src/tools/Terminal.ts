import * as vscode from 'vscode';

export class TerminalTools {
    private static terminal: vscode.Terminal | null = null;

    /**
     * Executes a command in the VS Code integrated terminal.
     */
    static async executeCommand(command: string): Promise<string> {
        if (!this.terminal) {
            this.terminal = vscode.window.createTerminal('Lattice Agent');
        }
        
        this.terminal.show();
        this.terminal.sendText(command);
        
        // Since we can't easily capture the output of the terminal in VS Code without complex task providers,
        // we return a status message. The LLM should rely on diagnostic/filesystem tools to verify results.
        return `Command sent to terminal: ${command}. Please wait for execution to complete.`;
    }

    /**
     * Kills the Lattice terminal instance.
     */
    static killTerminal() {
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = null;
        }
    }
}
