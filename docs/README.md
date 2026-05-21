# Lattice Documentation

This folder documents the low-level structure of the Lattice VS Code extension and its supporting backend.

Start here:

- [Project Map](./project-map.md): folder and file responsibilities.
- [Architecture](./architecture.md): main runtime components and how they connect.
- [Execution Flow](./execution-flow.md): prompt routing, planning, approval, tool execution, and memory pruning.
- [UI Event Contract](./ui-event-contract.md): messages passed between the extension host and webview.
- [Development Guide](./development.md): build, run, and verification notes.

## What Lattice Is

Lattice is a VS Code sidebar assistant with a tiered agent architecture:

- L0 Router: classifies prompts quickly.
- L1 Executor: performs chat, planning, and tool execution.
- L2 Critic: reviews plans and compresses long session history.
- UI Approval Gates: pause risky actions before execution or file mutation.

The extension lives under `extension/`. The older Python backend lives under `backend/`.

