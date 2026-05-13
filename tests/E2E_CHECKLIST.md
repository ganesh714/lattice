# Lattice E2E Checklist

This checklist guides a human tester through an end-to-end verification of the Lattice extension architecture: L0 Router, L1 Executor, L2 Critic, Self-Healing, and Memory Pruning, plus the UI diff approval flow.

Prerequisites
- Open this workspace in the Extension Development Host (Press `F5`).
- Open the Lattice sidebar view (View -> Lattice Chat).
- Ensure `extension.ts` loaded and `OnnxClient.init()` didn't error in the debug console.

1) Lane 1 — Fast Chat (L0 bypass)
- Prompt: `Explain what a Promise is in JavaScript.`
- Expected:
  - The webview returns a concise text answer (no file edits, no tools invoked).
  - The loading indicator shows short status updates like `Routing intent (L0)...` then `Thinking...`.

2) Lane 2 — Work Path (Clean edit + Diff Approval)
- Prompt: `Add a /logout endpoint to backend/main.py that clears the session cookie and returns 204.`
- Expected:
  - L0 Router classifies as `code_edit` and enters the Work Path.
  - The agent proposes an edit and the webview displays an inline diff card with Accept / Reject buttons.
  - A native VS Code split-diff opens showing original (left) and proposed (right).
  - The proposed side (right) is auto-focused.
  - Click **Accept** in the webview.
  - The agent applies the edit (file is modified on disk) and `get_workspace_diagnostics()` reports no errors.

3) Lane 2 — Self-Healing (introduce and fix a syntax error)
- Prompt: `Make a small change in backend/main.py that intentionally introduces a syntax error, then fix it.`
  (Alternatively, ask the agent to add code known to be syntactically invalid, e.g., missing colon.)
- Expected:
  - Agent performs `edit_file_diff` and the edit is applied.
  - `LspIntelligence.getWorkspaceDiagnostics()` reports Errors for the modified file.
  - The diagnostic strings are pushed back into `tool_history` and the model is given a chance to propose fixes.
  - The agent attempts automatic fixes up to 2 times. If successful, diagnostics disappear and flow continues; otherwise you are prompted for manual intervention.

4) Phase 5 — Memory Pruning (L2 Compression)
- Procedure:
  - Rapidly send 12+ short chat messages (e.g., `Q1?`, `Q2?`, ...) to push `chat_history` past the threshold.
- Expected:
  - After thresholds are exceeded, the UI shows `L2 Critic is compressing session memory...` and `🗜️ Compressing` step.
  - The extension compresses the session via `Critic.compressSession()` and replaces long histories with a single `system` summary message plus the last user prompt.

Notes & Troubleshooting
- If the ONNX-based L0 Router worker is not present, the Router falls back to the cloud provider; test classification accordingly.
- If the diff editor does not open on Windows, check the debug console for URI encoding errors. The `lattice-diff:` scheme uses encoded absolute paths and should be robust across platforms.
- To inspect `tool_history` and `chat_history` during tests, add temporary console logs in `AgentExecutor` or print via the Webview by posting debug messages.

End of checklist — if all steps pass, Lattice is functioning end-to-end.
