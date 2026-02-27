# MonoPilot Development Rules

Scope: this repository and all subdirectories.

## 1) Purpose of this file

`AGENTS.md` defines how agents should operate when running in this directory. The goal is to keep changes stable, reviewable, and reproducible.

## 2) Repository positioning (current stage)

- `mono-pilot` is a compatibility layer built on top of `pi-coding-agent`.
- Extension entrypoint: `src/extensions/mono-pilot.ts`
- Tool implementations: `tools/*.ts`
- Tool descriptions: `tools/*-description.md`

## 3) Required reading before coding

Before making any code changes, read these files fully:

1. `README.md`
2. `tools/README.md`
3. `src/extensions/mono-pilot.ts`
4. If changing a tool, read both that tool's `*.ts` and `*.md`

## 4) Tool migration / maintenance rules

A tool change is only complete when all of the following are true:

- Implementation exists: `tools/<name>.ts`
- Description exists: either a `tools/<name>-description.md` file, or an inline string in the `.ts` file.
  Use a separate `.md` file for long/structured descriptions; inline is fine when the description is short (a few sentences).
- Wired into extension entrypoint: `src/extensions/mono-pilot.ts`
- `tools/README.md` updated

Additional constraints:

- Do not expose built-in tools that overlap with custom tools by default (for example `edit` / `write`).
- Prefer `ApplyPatch` as the file mutation path.
- Keep changes focused: one tool, one purpose. Avoid mixing unrelated changes.

## 5) Run and validation

After code changes, always run:

- `npm run check`

Also run this when changing any of `src/`, `tools/*.ts`, `tools/*.md`, or build scripts:

- `npm run build`

Recommended smoke test:

- `npm start -- --help`

## 6) Git rules

- Do not commit unless explicitly requested.
- Never use `git add .` or `git add -A`.
- Stage only files changed in this task.
- Run `git status` before committing.

## 7) Documentation rules

- When adding/removing tools, update `tools/README.md` in the same change.
- If behavior changes affect usage, update root `README.md` as well.
- Keep docs implementation-focused and actionable; avoid promotional wording.

## 8) Change principles

- Prefer minimum viable changes first (MVP first).
- Prioritize correctness and testability before expansion.
- Do not include opportunistic refactors in the same change.
