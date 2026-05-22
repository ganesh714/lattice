# Development Guide

## Requirements

- Node.js compatible with the VS Code extension toolchain.
- VS Code.
- Optional model providers:
  - Gemini API key.
  - Groq API key.
  - Local Ollama endpoint.

## Install Dependencies

From the extension folder:

```bash
cd extension
npm install
```

## Compile

```bash
cd extension
npm run compile
```

The compile script runs:

```bash
tsc -p ./
```

## Run in VS Code

Open the repository in VS Code and launch the extension host through the normal VS Code extension debugging workflow.

The extension activates on:

- `onView:lattice.chatView`
- `onWebviewPanel:lattice.chatView`

## Configuration

Settings are defined in `extension/package.json` under `contributes.configuration`.

Important keys:

- `lattice.apiKeys.gemini`
- `lattice.apiKeys.groq`
- `lattice.local.ollamaEndpoint`
- `lattice.models.l1Model`
- `lattice.models.l2Model`
- `lattice.models.availableModels`
- `lattice.mcp.servers`

### MCP Servers Configuration

Lattice automatically connects to configured Model Context Protocol (MCP) servers on startup, dynamic reload, or configuration changes. You can configure them in two ways:

1. **Workspace Configuration File (`lattice-mcp.json`)**: Create a file named `lattice-mcp.json` at the root of the workspace. Its format matches standard Claude Desktop server configurations:
   ```json
   {
     "mcpServers": {
       "postgres": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
         "env": {
           "PGPASSWORD": "mysecretpassword"
         }
       }
     }
   }
   ```
2. **VS Code Settings (`lattice.mcp.servers`)**: Direct configuration under `settings.json` using the same object format.

The webview settings modal writes these values back into VS Code configuration through `LatticeChatProvider`.

## Manual Verification

Use `tests/E2E_CHECKLIST.md` for end-to-end checks.

Recommended checks after executor or UI changes:

1. Chat prompt returns a normal message.
2. Code edit prompt generates a plan and enters the tool loop.
3. `edit_file_diff` shows both inline approval and native VS Code diff.
4. Rejecting a diff stops that edit path.
5. A dangerous prompt such as "delete everything in this project" shows a Lane 3 plan approval card before any tool loop starts.
6. Approving the Lane 3 plan starts execution.
7. Rejecting the Lane 3 plan returns a rejection message and does not execute tools.

## Coding Notes

- Keep `AgentExecutor` responsible for orchestration.
- Keep VS Code-specific UI and configuration work in `LatticeChatProvider`.
- Keep webview DOM work in `main.js`.
- Keep tool schemas in `ToolRegistry.ts` aligned with executor tool handling.
- Use exact-block edits through `edit_file_diff` for file changes.
- Preserve approval gates for risky actions.

