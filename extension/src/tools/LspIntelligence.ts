import * as vscode from 'vscode';

export class LspIntelligence {
    /**
     * Pulls active IDE errors and warnings. 
     * Essential for the 'Self-Healing' phase of the Lattice Flow.
     */
    static async getWorkspaceDiagnostics(target?: string): Promise<string> {
        // If target is provided, attempt to resolve to a Uri
        const diagnostics = vscode.languages.getDiagnostics();
        let result = "";

        for (const [uri, diagList] of diagnostics) {
            const relativePath = vscode.workspace.asRelativePath(uri);
            if (target && typeof target === 'string') {
                // If a target path is provided, only include diagnostics for that file
                if (!relativePath.endsWith(target) && !relativePath.includes(target)) continue;
            }

            if (diagList.length > 0) {
                let fileResult = `File: ${relativePath}\n`;
                let hasImportant = false;

                for (const diag of diagList) {
                    // Only report Errors and Warnings (ignore Information/Hints to save tokens)
                    if (diag.severity === vscode.DiagnosticSeverity.Error || diag.severity === vscode.DiagnosticSeverity.Warning) {
                        const severityLabel = vscode.DiagnosticSeverity[diag.severity];
                        fileResult += `  [${severityLabel}] Line ${diag.range.start.line + 1}: ${diag.message}\n`;
                        hasImportant = true;
                    }
                }

                if (hasImportant) {
                    result += fileResult;
                }
            }
        }

        return result || "No active diagnostics found. Workspace is clean.";
    }
}
