# Project Map

## Root

```text
.
├── docs/
├── extension/
└── tests/
```

## `extension/`

The VS Code extension source.

```text
extension/
├── package.json
├── tsconfig.json
└── src/
    ├── agent/
    ├── models/
    ├── providers/
    ├── tools/
    ├── types/
    ├── webview/
    └── extension.ts
```

### `src/extension.ts`

Extension entry point.

Responsibilities:

- Activates the extension.
- Initializes the ONNX router worker through `OnnxClient.init(...)`.
- Registers `LatticeChatProvider` as the sidebar webview provider.

### `src/providers/LatticeChatProvider.ts`

Bridge between VS Code APIs, the webview, and `AgentExecutor`.

Responsibilities:

- Owns the webview lifecycle.
- Stores chat settings from VS Code configuration.
- Creates and reuses the session `AgentExecutor`.
- Sends status, steps, messages, diff approvals, and plan approvals to the webview.
- Resolves approval promises from webview button clicks.
- Opens native VS Code diff views for proposed file edits.

### `src/agent/`

Agent orchestration.

- `AgentExecutor.ts`: central runtime loop for prompts, routing, planning, approval gates, tools, and memory pruning.
- `Router.ts`: L0 prompt classifier wrapper.
- `Critic.ts`: L2 plan review and session compression.
- `ContextEngine.ts`: passive context and context pruning.

### `src/models/`

Model provider layer.

- `ModelFactory.ts`: chooses a provider from the selected model string and falls back to configured providers.
- `GeminiClient.ts`: Gemini provider.
- `GroqClient.ts`: Groq provider.
- `OllamaClient.ts`: local Ollama provider.
- `OnnxClient.ts`: client wrapper for ONNX intent classification.
- `OnnxWorker.ts`: worker-thread implementation for fast local routing.

### `src/tools/`

Tool implementations available to the agent loop.

- `ToolRegistry.ts`: tool schema definitions shown to model providers.
- `FileSystem.ts`: list, read, search, and exact-block edit helpers.
- `Terminal.ts`: command execution helper.
- `LspIntelligence.ts`: workspace diagnostics helper.
- `Security.ts`: regex-based prompt risk detector.
- `McpClient.ts`: universal MCP client implementing JSON-RPC 2.0 communication over stdin/stdout to connect to external servers and load/run dynamic tools.

### `src/webview/`

Sidebar UI.

- `index.html`: webview shell.
- `main.js`: webview state, message handling, settings, approvals, and chat rendering.
- `style.css`: webview styling.

### `src/types/`

Shared TypeScript interfaces for model requests, tool calls, text responses, and chat history.

## `tests/`

Manual verification docs.

- `E2E_CHECKLIST.md`: human test scenarios for routing, editing, self-healing, memory pruning, and approvals.

