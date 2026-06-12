# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Conclave** — self-hosted multi-agent RP/writing platform. Rust + axum + SQLite backend, React + TypeScript + Vite frontend.

## Commands

```bash
# Start both backend and frontend (from repo root)
./start.sh

# Backend only
cd backend && cargo run

# Frontend only
cd frontend && npm run dev     # dev server on :5173, proxies /api → :3001

# Frontend tests
cd frontend && npm test         # runs node --test on st-regex-executor.test.ts and runtime-host-protocol.test.ts

# Frontend build
cd frontend && npm run build    # tsc && vite build

# Backend lint/typecheck
cd backend && cargo check
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `sqlite:conclave.db` | SQLite connection string |
| `BIND_HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `3001` | Backend port |
| `API_AUTH_TOKEN` | (empty) | Bearer token for API auth; required if `BIND_HOST` is non-loopback |
| `RUST_LOG` | `info` | Tracing filter (uses `tracing-subscriber` env-filter) |

## Architecture

### Backend (`backend/src/`)

- **`main.rs`** — axum router with all `/api/*` routes, auth middleware, CORS, tracing
- **`db.rs`** — SQLite pool (WAL mode, max 5 connections), runs migrations at startup via `include_str!` on `migrations/*.sql`
- **`config.rs`** — `AppConfig` from env vars
- **`error.rs`** — unified `AppError` type
- **`routes/`** — REST handlers: sessions, messages, providers, proposals, agents, worldbooks, charactercards, presets, card_import, settings, variables, runtime_assets
- **`runtime/`** — Multi-agent execution engine:
  - `graph.rs` / `turn_service.rs` — orchestrates the 4-layer pipeline: Parser → Master → Sub-agents → Writer → Compression
  - `master.rs` — master agent generates `MasterPlan` from `ContextBundle` + `ParsedIntent`
  - `dag.rs` / `plan_validator.rs` — DAG compilation for parallel sub-agent execution
  - `executor.rs` — SSE streaming with broadcast channel for multi-subscriber reconnect
  - `compression.rs` — post-processing: scene_summary, events, foreshadowing, state_changes
  - `context.rs` / `state_initializer.rs` — ContextBundle construction from DB state snapshots
  - `recall.rs` — structured event recall (keyword matching, vector search placeholder)
  - `turn_finalizer.rs` — message save + memory write + trace + state commit
  - `variable_tool_agent.rs` / `variable_update.rs` — variable read/write tool calls
  - `background_jobs.rs` — background task scheduler (compression, cleanup)
  - `llm_limiter.rs` — LLM concurrency limiter
- **`importer/`** — SillyTavern card import pipeline (JSON/PNG/HTML parsing, JS analysis, regex execution, variable extraction, LLM assist, package building)
- **`memory/`** — structured state (`state.rs`), summaries (`summaries.rs`)
- **`provider/`** — LLM provider adapter (OpenAI-compatible)
- **`migrations/`** — numbered SQL files (001–016), applied in order at startup
- **`schemas/`** — JSON Schema definitions for cross-module data contracts

### Frontend (`frontend/src/`)

- **`api/`** — API client (`client.ts`), SSE handler (`sse.ts`), shared types
- **`pages/`** — main views: Chat, SessionList, SessionDebug, AgentManager, Settings, WorldBooks, CharacterCard, Presets, ImportWorkbench
- **`pages/components/`** — chat UI components: MessageContent, InputPanel, ToolRail, ToolDrawer, InspectorSidebar, IframeHtmlRuntimeHost, etc.
- **`pages/hooks/`** — `useChatSession`, `useMessageStream`, `useStreamRecovery`
- **`pages/st-regex-executor.ts`** — SillyTavern regex executor (runs in browser)
- **`pages/sandbox-*` / `pages/st-*`** — card rendering runtime: iframe sandbox, ST-compatible macro/regex engine, TavernHelper shim, postMessage bridge
- **`components/`** — AppShell, Sidebar, ErrorBoundary, Toast, NewSessionDialog
- **`contexts/AppContext.tsx`** — global app state

### Card Rendering Pipeline

Character cards use an iframe-based sandbox with SillyTavern compatibility. The frontend runs ST regex macros via `st-regex-executor.ts`, injects results into an iframe via `IframeHtmlRuntimeHost`, and bridges runtime calls through `postMessage`. Key files: `sandbox-document.ts`, `sandbox-host-bridge.ts`, `iframe-bridge.ts`, `st-rendering-engine.ts`, `st-opening-ui.ts`, `st-init-variables.ts`.

## CodeGraph Requirement

Before answering code questions or making changes: call `codegraph_status` to verify index health, then use `codegraph_explore` to locate symbols and context. Prefer CodeGraph over manual grep/find.

## Key Conventions

- **Character card compatibility**: Never hard-parse a single card or hardcode field mappings for one card's Chinese names/UI text. Implement generic compatibility layers that serve an entire class of cards. See AGENT.md for the full policy.
- **Structured schemas first**: All cross-module data (Agent Graph, ContextBundle, NodeOutput, StateChangeProposal, MemoryEvent, etc.) must use typed schemas in `backend/schemas/`, not ad-hoc string parsing.
- **Documentation sync**: Code changes that affect runtime behavior, memory, agent boundaries, database/API, card rendering, or test specs MUST update the corresponding `docs/*.md` file. See AGENT.md for the full mapping.
- **Doc reading order**: Before implementing a feature, read the relevant doc from `docs/` as listed in AGENT.md's "文档阅读顺序" section.
- **Migrations**: New migrations go in `backend/migrations/` as numbered SQL files. The migration is applied in `db.rs` via `include_str!` — add a new block there.
- **API auth**: Optional bearer token via `API_AUTH_TOKEN`. When set, requests need `Authorization: Bearer <token>` or `x-api-key: <token>`. Health check and OPTIONS are always unauthenticated.
