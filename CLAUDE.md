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
- **Two list views** keyed off `location.hash`: the normal view (`GET /todos?status=TODO`) and a deliberately hidden completed view (`#done`, `status=DONE`), toggled by long-pressing the header title (`toggleView`). There is intentionally no visible tab/button for the completed view. Lists load in batches via `loadTodoBatch` + an `IntersectionObserver` sentinel because the backend filters after `Limit`, so pages can be short or empty while `nextCursor` is non-null.
- **Steps add/delete/reorder** all go through `replaceSteps` → `PATCH /todos/{id}` with the whole `steps` array (new steps have no `id`; the server assigns one). Single-step edits / done toggles still use `apiUpdateStep`. Reordering is long-press + drag (`attachLongPress`, `startStepDrag`/`handleStepDragMove`/`finishStepDrag`) with no buttons or handles by design; `touchmove` is `preventDefault`ed only while a drag is active, and the click that follows a long-press is swallowed (`suppressNextClick`). The step-delete × acts on `pointerdown` because a `click` would arrive after the input's blur has already re-rendered the row.
- **Undo toasts** (`showToast`) replace confirm dialogs for completing a todo and deleting a step.
- **Add dialog options** (type, AI on/off, model, step count, research mode) build the `POST /todos` body in `buildCreateRequest`. Model choices come from `config.models`/`config.defaultModel` in the pasted `frontend_config`; older configs without `models` simply omit `ai.model`. The last selections are kept in `localStorage` under `todo-app:inputPrefs`.
- Todo deletion (`DELETE /todos/{id}`) has no UI yet, although the backend endpoint exists.

## Current phase

Phase 2 is implemented: input options (type chosen by the user, optional AI with model choice, step count, research summary vs. research-prompt generation), step add/delete/long-press reorder, and the hidden completed view. "Regenerate" was dropped from the spec entirely — don't add it.
