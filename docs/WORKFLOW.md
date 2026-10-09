# Two-agent workflow (Unmanned Library)

Two coding agents work in parallel on the same project. This file is the rulebook for both. Read it before every task.

## Roles and ownership

| Agent | Owns (may edit) | Must not edit |
|---|---|---|
| Backend agent | /server, docs/API.md, docs/DEMO_ACCOUNTS.md, backend rows of docs/QUALITY_TRACEABILITY.md | /web |
| Frontend agent | /web, docs/DESIGN_SYSTEM.md, docs/API_REQUESTS.md | /server |

Shared files (root package.json, README.md, .gitignore): small additive edits only (add a script, add a line), mentioned in the commit message.

## The contract

- docs/API.md is the single source of truth for the HTTP API and the SSE events: method, path, required role, request and response JSON examples, error format, and a status of implemented / partial / missing.
- The backend agent changes an endpoint only together with an update of docs/API.md in the same commit.
- The frontend agent never edits /server. If it needs an endpoint that is missing or different, it appends a request to docs/API_REQUESTS.md (endpoint, reason, request/response shape) and works against a mock handler (for example MSW) until the backend delivers it.
- The backend agent reads docs/API_REQUESTS.md at the start of each task and either implements the request or answers in the same file.

## Git

- Backend work happens on branch `backend`, frontend work on branch `frontend` (separate working folders via git worktree).
- Small commits with a prefix: `be:` or `fe:`. Never force-push, never rewrite history.
- Before starting a task, merge the other branch if it changed docs/API.md.
- The user merges both branches into master.

## Running

- The backend server runs from the backend working folder on port 3001. The frontend dev server runs on port 3000 and proxies /api to 3001. The frontend agent does not start its own server unless told to.
- Seed data: `npm run seed` in the backend folder. Demo accounts are listed in docs/DEMO_ACCOUNTS.md.

## Working style

- One prompt = one task. No work outside the task, no new dependencies without saying so.
- Finish every task with a report of at most 10 lines: what changed, what to check, what is still missing.
- On a rate-limit or gateway error, stop and wait; do not retry in a loop.
