# Execution Flow

## High-Level Sequence

```text
prompt
  |
  v
Security.check(prompt)
  |
  +-- risky --> intent = LANE_3
  |
  +-- safe  --> Router.classify(prompt)
                  |
                  +-- chat
                  +-- code_edit
  |
  v
chat flow or work flow
```

## Chat Flow

Used when intent is `chat`.

1. `AgentExecutor.runChatFlow(...)` asks `ContextEngine` for passive context.
2. The request is sent through `ModelFactory.generateWithFallback(...)`.
3. Tools are disabled.
4. If the chat model returns `[LATTICE_REROUTE: LANE_2]`, the executor suppresses that marker and immediately enters `runExecutionFlow(...)` with the original user prompt.
5. Otherwise, the text response is rendered in the webview.

The reroute marker is an escape hatch for misclassified prompts. It lets a chat-only model hand off explicit read, edit, search, or terminal requests to the tool-enabled execution loop.

## Standard Work Flow

Used when intent is `code_edit`.

1. `AgentExecutor.createReviewedPlan(...)` creates an implementation plan.
2. `Critic.reviewPlan(...)` reviews the plan.
3. If L2 rejects the first plan, L1 refines it.
4. The refined plan is reviewed again.
5. Execution enters `runExecutionFlow(...)`.

Standard work does not require plan approval before execution, but individual file edits still require diff approval.

## Lane 3 Work Flow

Used when the security pre-check flags a risky prompt.

Examples of prompts that can enter Lane 3:

- Requests containing destructive keywords such as `delete`, `wipe`, `erase`, or `destroy`.
- Broad rewrite requests such as "rewrite all".
- Broad refactor requests such as "modify everything".
- Shell-risk patterns such as `rm -rf`, `sudo`, or `curl ... | bash`.

Lane 3 sequence:

1. `PromptSanitizer.check(prompt)` returns `blocked: true`.
2. `AgentExecutor` sets intent to `LANE_3`.
3. The ONNX router is bypassed.
4. L1 generates a step-by-step plan.
5. L2 reviews the plan for safety.
6. If needed, L1 refines the plan and L2 reviews it again.
7. The executor fires `request_plan_approval` to the webview.
8. The executor waits on `askPlanApproval(...)`.
9. If approved, execution enters `runExecutionFlow(...)`.
10. If rejected, execution stops and asks the user for revised instructions.

Important rule:

`runExecutionFlow(...)` must not start before the Lane 3 approval promise resolves to `true`.

## Tool Execution Loop

`runExecutionFlow(...)` repeatedly asks the selected L1 model what to do next.

Lane 2 receives smart passive active-file context:

- Files up to 100 lines are included in full.
- Larger files include the active selection when present.
- Larger files include a 20-line window around the cursor or selection.
- The active file path and total line count are always included.

Because this context can be partial, the Lane 2 system prompt tells the agent to use `search_workspace_regex` or `read_file_chunk` before editing when it needs full structure or specific symbols.

For each model response:

- If response type is `tool_call`, execute the requested tool.
- Store the tool result in `toolHistory`.
- Continue with the updated tool history.
- If response type is `message`, return that message as the final answer.

The loop is capped by `MAX_CONSECUTIVE_TOOLS`.

## File Edit Approval

When the model calls `edit_file_diff`:

1. Executor calls `ui.askApproval(target, oldText, newText)`.
2. Provider posts `askApproval` to the webview.
3. Provider opens a native VS Code diff view.
4. Webview shows an inline diff approval card.
5. User clicks Accept or Reject.
6. Webview posts `approveEdit` or `rejectEdit`.
7. Provider resolves the pending promise.
8. Executor applies the edit only if approved.

After an approved edit, `LspIntelligence.getWorkspaceDiagnostics()` checks the workspace. Diagnostics are fed back into the tool loop so the model can self-heal.

## Memory Pruning

After execution, `AgentExecutor` checks history size.

If history is large:

1. It calls `Critic.compressSession(...)`.
2. Tool history is cleared.
3. Chat history is replaced with a compact system summary.
4. The latest user message is kept for immediate context.
