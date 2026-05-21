# UI Event Contract

This document lists messages passed between the extension host and the webview.

## Extension Host to Webview

These are sent with `webview.postMessage(...)`.

### `initSettings`

Initial settings payload.

```ts
{
  type: 'initSettings',
  settings: {
    geminiApi?: string,
    groqApi?: string,
    ollamaUrl?: string,
    l1Model?: string,
    l2Model?: string,
    availableModels?: {
      gemini: string[],
      groq: string[],
      ollama: string[]
    }
  }
}
```

### `addMessage`

Adds a chat message.

```ts
{
  type: 'addMessage',
  text: string,
  isUser: boolean,
  isError?: boolean
}
```

### `startBotMessage`

Creates the current bot response container.

```ts
{ type: 'startBotMessage' }
```

### `addStep`

Adds an agent step under the active bot message.

```ts
{
  type: 'addStep',
  icon: string,
  action: string,
  target: string
}
```

### `setLoading`

Shows or updates the loading indicator.

```ts
{
  type: 'setLoading',
  text: string
}
```

### `statusUpdate`

Updates subtext inside the loading indicator.

```ts
{
  type: 'statusUpdate',
  value: string
}
```

### `removeLoading`

Removes the loading indicator.

```ts
{ type: 'removeLoading' }
```

### `generationFinished`

Resets the send button from stop mode back to send mode.

```ts
{ type: 'generationFinished' }
```

### `askApproval`

Requests approval for a file edit.

```ts
{
  type: 'askApproval',
  id: string,
  target: string,
  oldText: string,
  newText: string
}
```

Expected response:

- `approveEdit`
- `rejectEdit`

### `request_plan_approval`

Requests approval before executing a Lane 3 plan.

```ts
{
  type: 'request_plan_approval',
  id: string,
  plan: string
}
```

Expected response:

- `approvePlan`
- `rejectPlan`

### `debugUpdate`

Pushes executor internals to the debug panel.

```ts
{
  type: 'debugUpdate',
  chat_history: ChatMessage[],
  tool_history: ToolResponse[]
}
```

## Webview to Extension Host

These are sent with `vscode.postMessage(...)`.

### `ready`

Sent when the webview JS initializes.

```ts
{ type: 'ready' }
```

### `prompt`

Submits user text.

```ts
{
  type: 'prompt',
  text: string,
  model?: string
}
```

### `updateSettings`

Persists settings to VS Code configuration.

```ts
{
  type: 'updateSettings',
  settings: object
}
```

### `approveEdit` / `rejectEdit`

Resolves a pending edit approval.

```ts
{
  type: 'approveEdit' | 'rejectEdit',
  id: string
}
```

### `approvePlan` / `rejectPlan`

Resolves a pending Lane 3 plan approval.

```ts
{
  type: 'approvePlan' | 'rejectPlan',
  id: string
}
```

### `abortGeneration`

Currently sent by the webview stop button. The provider does not yet implement cancellation handling.

```ts
{ type: 'abortGeneration' }
```

