import * as fs from 'fs';
import * as path from 'path';

// --- MOCK VSCODE ---
const vscodeMock = {
    workspace: {
        fs: {
            readFile: async (uri: any) => fs.promises.readFile(uri.fsPath)
        },
        getConfiguration: (section: string) => ({
            get: (key: string) => {
                if (key === 'apiKeys.gemini') return process.env.GEMINI_API_KEY;
                if (key === 'apiKeys.groq') return process.env.GROQ_API_KEY;
                if (key === 'local.ollamaEndpoint') return "http://127.0.0.1:11434";
                return undefined;
            }
        })
    },
    Uri: {
        file: (p: string) => ({ fsPath: p })
    }
};

// Intercept require calls to inject our mock
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id: string) {
    if (id === 'vscode') return vscodeMock;
    return originalRequire.apply(this, arguments);
};

// --- NOW IMPORT EXTENSION CODE ---
// We must use require() here because imports are hoisted and we need the mock to run first.
const { FileIntelligenceAgent } = require('../src/agent/fileIntelligence/FileIntelligenceAgent');

async function main() {
    if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
        console.error("❌ Please set GEMINI_API_KEY or GROQ_API_KEY environment variable.");
        process.exit(1);
    }

    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.log(`
Usage:
  npx ts-node scripts/test-file-agent.ts <file>                        # Test analyze_large_file
  npx ts-node scripts/test-file-agent.ts <file> --symbol <symbolName>  # Test deep_dive_symbol

Example:
  $env:GEMINI_API_KEY="your-key"
  npx ts-node scripts/test-file-agent.ts src/interviewer.html
        `);
        process.exit(0);
    }

    const filePath = path.resolve(args[0]);
    const symbolIndex = args.indexOf("--symbol");
    const symbolName = symbolIndex !== -1 ? args[symbolIndex + 1] : undefined;
    const model = process.env.GROQ_API_KEY ? "groq:llama-3.1-8b-instant" : "gemini-3.5-flash"; // Default test model
    const workspacePath = path.dirname(filePath);

    console.log(`🚀 Starting FileIntelligenceAgent Test`);
    console.log(`📁 File: ${filePath}`);
    console.log(`🧠 Model: ${model}`);

    try {
        if (symbolName) {
            console.log(`\n--- TESTING analyze_large_file (Building Cache First) ---`);
            await FileIntelligenceAgent.analyze(workspacePath, filePath, model);
            
            console.log(`\n--- TESTING deep_dive_symbol ("${symbolName}") ---`);
            const deepDive = await FileIntelligenceAgent.fetchSymbol(workspacePath, filePath, model, symbolName);
            console.log(deepDive);
        } else {
            console.log(`\n--- TESTING analyze_large_file ---`);
            const result = await FileIntelligenceAgent.analyze(workspacePath, filePath, model);
            const summary = FileIntelligenceAgent.formatSummary(result);
            console.log(summary);
        }
    } catch (err: any) {
        console.error("\n❌ Error:", err.message);
        if (err.stack) console.error(err.stack);
    }
}

main();
