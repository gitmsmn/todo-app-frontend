# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Frontend for 「大雑把なTODOをAIが分解・調査するTODOアプリ」(a TODO app where AI breaks down or researches vague tasks). This repo is **public** and contains only static files (`index.html`, `style.css`, `app.js`) — no build step, no framework, no dependencies.

It is deployed via GitHub Pages directly from `main` (root). There is no CI (no GitHub Actions) because there is nothing to build.

The backend (Lambda + DynamoDB + Terraform) and detailed specs (architecture, data model, API spec, cost estimates) live in a **separate, private** companion repo: `todo-app-backend`. `app.js` implements the contract defined there (`docs/frontend-spec.md` / `docs/api-spec.md`) — when behavior here seems arbitrary or under-specified, the backend repo's specs are the source of truth, not this repo.

## Critical constraint: no secrets in this repo

This repo is public. The API key and the per-function Lambda Function URLs must never be committed here. They are pasted by the user into the in-page settings dialog (⚙) on first use and stored only in `localStorage` (key `todo-app:config`), read fresh from `terraform output -raw frontend_config` in the backend repo. Never add hardcoded endpoints, keys, or `.env`-style config files to this repo.

## Running / testing

There is no build, lint, or test tooling. To work on this locally, serve the directory with any static file server (e.g. `npx serve .` or `python -m http.server`) and open it in a browser — opening `index.html` directly via `file://` will work for layout but API calls still require a valid config pasted into the settings dialog, pointing at a real deployed backend.

There are no automated tests. Verify changes manually in the browser against a real (or stubbed) backend.

## Architecture

Single-page, vanilla JS, no modules/bundler — `app.js` is one file loaded via a plain `<script>` tag, with module-scope `config` and `todos` as the only state.

- **Config/API client** (`loadConfig`/`saveConfig`, `apiFetch`, `apiListTodos`/`apiCreateTodo`/`apiUpdateTodo`/`apiUpdateStep`/`apiDeleteTodo`): each CRUD-ish operation hits a *different* Lambda Function URL (no API Gateway path routing), so `config.endpoints` is a map of distinct base URLs rather than one API base + paths. `buildUrl` appends `todos/{id}` etc. onto whichever endpoint URL is relevant.
- **Rendering** is fully manual DOM construction via the `el(tag, props, children)` helper (no innerHTML templating, no virtual DOM) — `renderList()` wipes and rebuilds `#todoList` from the in-memory `todos` array on every mutation. There's no diffing; any state change calls `renderList()` again.
- **Two todo types** render differently inside the same card (`createTodoCardElement`): `BREAKDOWN` (a checklist of steps, see `buildStepList`) vs. a research type (Markdown summary + sources, see `buildResearchDetail`). The type badge and detail body branch on `todo.type`.
- **Inline editing** (title, step title/reason, research summary) follows one pattern throughout: replace the display element with an `<input>`/`<textarea>`, commit the PATCH on blur/Enter, then call `renderList()` regardless of success or failure (errors surface via `showError` and the list still re-renders from current in-memory state).
- **Markdown rendering** (`renderMarkdownToHtml`/`inlineMarkdown`/`escapeHtml`) is a small hand-rolled subset (headings, `-`/`*` lists, `---` hr, `**bold**`/`*italic*`) used only to display AI-generated research summaries. `escapeHtml` runs first and unconditionally — there is no raw-HTML injection path; keep it that way if extending the renderer.
- Deletion is logical on the backend (comment in `handleDelete`'s confirm dialog) — the frontend just removes the item from the local `todos` array and re-renders after a successful DELETE call.

## Current phase

Phase 1 is implemented (CRUD, inline editing, status toggle, logical delete, Markdown display). "Regenerate" (re-running AI breakdown/research on an existing todo) is explicitly deferred to Phase 2 and not implemented yet.
