# Architecture

## Runtime Layers

Lattice is organized around three model layers and one UI layer.

```text
User
  |
  v
Webview UI
  |
  v
LatticeChatProvider
  |
  v
AgentExecutor
  |
  +--> L0 Router
  +--> L1 Model
  +--> L2 Critic
  +--> Tools
```

## Webview UI

Files:

- `extension/src/webview/index.html`
- `extension/src/webview/main.js`
- `extension/src/webview/style.css`

The webview renders chat messages, agent steps, settings, diff approval cards, and Lane 3 plan approval cards.

It cannot call extension APIs directly. It communicates by:

- Receiving messages through `window.addEventListener('message', ...)`.
- Sending messages through `vscode.postMessage(...)`.

## Extension Host Provider

File:

- `extension/src/providers/LatticeChatProvider.ts`

`LatticeChatProvider` is the trusted bridge. It can use VS Code APIs, read configuration, open diff editors, and communicate with the webview.

The provider implements `IAgentUI`, which lets `AgentExecutor` stay UI-agnostic:

- `addStep(...)`
- `setLoading(...)`
- `removeLoading()`
- `statusUpdate(...)`
- `askApproval(...)`
- `askPlanApproval(...)`

## Agent Executor

File:

- `extension/src/agent/AgentExecutor.ts`

`AgentExecutor` owns the main prompt lifecycle:

1. Copy incoming chat history into executor state.
2. Run security pre-checks.
3. Route prompt intent.
4. Run chat flow or work flow.
5. Generate and review plans for work.
6. Pause for Lane 3 plan approval when needed.
7. Run the tool loop.
8. Ask for edit approval before applying file diffs.
9. Run diagnostics after approved edits.
10. Compress long histories through L2.

## Model Layer

Files:

- `extension/src/models/ModelFactory.ts`
- `extension/src/models/GeminiClient.ts`
- `extension/src/models/GroqClient.ts`
- `extension/src/models/OllamaClient.ts`

`ModelFactory.generateWithFallback(...)` resolves the selected model into a provider. It tries the selected provider first, then configured fallback providers.

Model selection is string-based. Examples:

- `gemini:gemini-2.5-flash`
- `groq:llama-3.3-70b-versatile`
- `ollama:llama3`

## Tool Layer

Files:

- `extension/src/tools/ToolRegistry.ts`
- `extension/src/tools/FileSystem.ts`
- `extension/src/tools/Terminal.ts`
- `extension/src/tools/LspIntelligence.ts`

Tools are exposed to model providers through schemas and executed by `AgentExecutor.runExecutionFlow(...)`.

The safest file mutation path is `edit_file_diff`, because it:

- Requires an exact `search_block`.
- Requires at least three lines in the search block.
- Shows the proposed diff to the user.
- Applies the edit only after approval.

