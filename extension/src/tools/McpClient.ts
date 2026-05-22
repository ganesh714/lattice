import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import { registerMcpTool, resetTools } from './ToolRegistry';

class McpServerConnection {
    private process?: ChildProcess;
    private idCounter = 0;
    private pendingRequests = new Map<number | string, { resolve: (res: any) => void; reject: (err: any) => void }>();
    private rl?: readline.Interface;

    public status: 'connected' | 'error' | 'connecting' = 'connecting';
    public errorText?: string;
    public tools: any[] = [];

    constructor(
        public name: string,
        private command: string,
        private args: string[],
        private env: Record<string, string> = {}
    ) {}

    async start(): Promise<any[]> {
        this.status = 'connecting';
        this.errorText = undefined;
        this.tools = [];
        return new Promise((resolve, reject) => {
            try {
                console.log(`[McpClient] Spawning MCP server "${this.name}": ${this.command} ${this.args.join(' ')}`);
                
                this.process = spawn(this.command, this.args, {
                    env: { ...process.env, ...this.env },
                    shell: true
                });

                this.process.on('error', (err) => {
                    console.error(`[McpClient] Server ${this.name} failed to spawn:`, err);
                    this.status = 'error';
                    this.errorText = err.message || String(err);
                    reject(err);
                });

                if (!this.process.stdout || !this.process.stdin) {
                    const err = new Error("Stdout or Stdin is not available on spawned process");
                    this.status = 'error';
                    this.errorText = err.message;
                    throw err;
                }

                this.rl = readline.createInterface({
                    input: this.process.stdout,
                    terminal: false
                });

                this.rl.on('line', (line) => {
                    this.handleLine(line);
                });

                this.process.stderr?.on('data', (data) => {
                    console.warn(`[McpClient] [${this.name} stderr] ${data.toString()}`);
                });

                this.process.on('close', (code) => {
                    console.log(`[McpClient] Server ${this.name} exited with code ${code}`);
                    if (this.status !== 'error') {
                        this.status = 'error';
                        this.errorText = `Exited with code ${code}`;
                    }
                    // Reject all pending requests
                    for (const [id, pending] of this.pendingRequests.entries()) {
                        pending.reject(new Error(`Server closed with code ${code}`));
                    }
                    this.pendingRequests.clear();
                });

                // Start Handshake: initialize
                this.initializeHandshake()
                    .then(tools => {
                        this.status = 'connected';
                        this.tools = tools;
                        resolve(tools);
                    })
                    .catch(err => {
                        this.status = 'error';
                        this.errorText = err.message || String(err);
                        this.shutdown();
                        reject(err);
                    });

            } catch (err: any) {
                this.status = 'error';
                this.errorText = err.message || String(err);
                reject(err);
            }
        });
    }

    private handleLine(line: string) {
        if (!line.trim()) return;
        try {
            const message = JSON.parse(line);
            if (message.jsonrpc === "2.0") {
                if (message.id !== undefined) {
                    // Response
                    const pending = this.pendingRequests.get(message.id);
                    if (pending) {
                        this.pendingRequests.delete(message.id);
                        if (message.error) {
                            pending.reject(message.error);
                        } else {
                            pending.resolve(message.result);
                        }
                    }
                } else {
                    // Notification or request without id (from server)
                    console.log(`[McpClient] [${this.name}] Received notification:`, message);
                }
            }
        } catch (e) {
            console.error(`[McpClient] [${this.name}] Failed to parse JSON-RPC line:`, line, e);
        }
    }

    private sendRequest(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.process || !this.process.stdin) {
                return reject(new Error("Process stdin is not available"));
            }
            const id = ++this.idCounter;
            const request = {
                jsonrpc: "2.0",
                id,
                method,
                params
            };
            this.pendingRequests.set(id, { resolve, reject });
            this.process.stdin.write(JSON.stringify(request) + '\n');
        });
    }

    private sendNotification(method: string, params: any = {}) {
        if (!this.process || !this.process.stdin) {
            return;
        }
        const notification = {
            jsonrpc: "2.0",
            method,
            params
        };
        this.process.stdin.write(JSON.stringify(notification) + '\n');
    }

    private async initializeHandshake(): Promise<any[]> {
        const initResult = await this.sendRequest("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
                name: "LatticeClient",
                version: "0.1.0"
            }
        });
        
        this.sendNotification("notifications/initialized");

        const toolsResult = await this.sendRequest("tools/list");
        return toolsResult.tools || [];
    }

    async callTool(toolName: string, args: any): Promise<string> {
        try {
            const result = await this.sendRequest("tools/call", {
                name: toolName,
                arguments: args
            });

            if (result.isError) {
                const errorText = result.content?.map((c: any) => c.text || '').join('\n') || 'Unknown error';
                throw new Error(errorText);
            }

            const textParts = result.content
                ?.filter((c: any) => c.type === 'text')
                ?.map((c: any) => c.text) || [];
            
            return textParts.join('\n');
        } catch (err: any) {
            throw new Error(`MCP tool call failed: ${err.message || JSON.stringify(err)}`);
        }
    }

    shutdown() {
        try {
            this.rl?.close();
            this.process?.kill();
        } catch (e) {}
    }
}

export class McpClient {
    private static connections = new Map<string, McpServerConnection>();
    private static mcpToolMap = new Map<string, { connection: McpServerConnection; originalName: string }>();

    static getServersStatus(): any[] {
        const list: any[] = [];
        for (const [name, conn] of this.connections.entries()) {
            list.push({
                name,
                status: conn.status,
                errorText: conn.errorText,
                tools: conn.tools.map(t => ({ name: t.name, description: t.description }))
            });
        }
        return list;
    }

    static async initialize(workspacePath: string, ui?: any) {
        // First shutdown any active connections
        this.shutdown();
        resetTools();
        this.mcpToolMap.clear();

        if (!workspacePath) return;

        ui?.setLoading?.("Loading MCP configurations...");
        
        let mcpConfig: any = {};
        
        // 1. Load from workspace config file
        const configPath = path.join(workspacePath, 'lattice-mcp.json');
        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf8');
                const parsed = JSON.parse(content);
                mcpConfig = parsed.mcpServers || parsed;
                console.log("[McpClient] Loaded configurations from lattice-mcp.json:", Object.keys(mcpConfig));
            } catch (e: any) {
                console.error("[McpClient] Error reading lattice-mcp.json:", e);
                ui?.addStep?.('⚠️', 'MCP Config', `Failed to parse lattice-mcp.json: ${e.message}`);
            }
        }

        // 2. Load from VS Code Settings
        const config = vscode.workspace.getConfiguration('lattice');
        const settingsServers = config.get<any>('mcp.servers') || {};
        
        mcpConfig = { ...mcpConfig, ...settingsServers };

        const serverNames = Object.keys(mcpConfig);
        if (serverNames.length === 0) {
            console.log("[McpClient] No MCP servers configured.");
            ui?.sendMcpStatusUpdate?.();
            return;
        }

        for (const name of serverNames) {
            const serverDef = mcpConfig[name];
            if (!serverDef || !serverDef.command) continue;

            ui?.setLoading?.(`Connecting to MCP server: ${name}...`);
            const connection = new McpServerConnection(
                name,
                serverDef.command,
                serverDef.args || [],
                serverDef.env || {}
            );
            this.connections.set(name, connection);
            ui?.sendMcpStatusUpdate?.();

            try {
                const tools = await connection.start();

                for (const tool of tools) {
                    const fullName = `${name}__${tool.name}`;
                    this.mcpToolMap.set(fullName, {
                        connection,
                        originalName: tool.name
                    });

                    registerMcpTool({
                        name: fullName,
                        description: `[MCP Server: ${name}] ${tool.description || ''}`,
                        parameters: tool.inputSchema || { type: "object", properties: {}, required: [] }
                    });
                }

                ui?.addStep?.('🔌', 'MCP Server', `Connected to ${name} (${tools.length} tools registered)`);
            } catch (err: any) {
                console.error(`[McpClient] Failed to start MCP server "${name}":`, err);
                ui?.addStep?.('❌', 'MCP Server', `Failed to connect to ${name}: ${err.message || err}`);
            } finally {
                ui?.sendMcpStatusUpdate?.();
            }
        }
    }

    static isMcpTool(toolName: string): boolean {
        return this.mcpToolMap.has(toolName);
    }

    static async executeMcpTool(toolName: string, args: any): Promise<string> {
        const mapping = this.mcpToolMap.get(toolName);
        if (!mapping) {
            throw new Error(`MCP tool "${toolName}" is not registered.`);
        }
        return await mapping.connection.callTool(mapping.originalName, args);
    }

    static shutdown() {
        for (const conn of this.connections.values()) {
            try {
                conn.shutdown();
            } catch (e) {}
        }
        this.connections.clear();
        this.mcpToolMap.clear();
    }
}
