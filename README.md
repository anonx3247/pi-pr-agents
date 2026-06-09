# pi-pr-agents

A [pi](https://pi.dev) package that turns one persistent **main agent** into a PR
orchestrator. You give it work; it splits the work into small pull requests and
hands **each PR to its own dedicated subagent** running in an isolated git
worktree, laid out as a labelled **tmux pane** beside the main agent.

```
┌──────────────────────────┬───────────────────────────┐
│                          │  PR#42 Add limiter (pi/…) │
│                          ├───────────────────────────┤
│   main agent (you)       │  PR#43 Wire config (pi/…) │
│   — orchestrator —       ├───────────────────────────┤
│   never writes code      │  ↳ helper: review         │
└──────────────────────────┴───────────────────────────┘
```

## What it does

- **One subagent per PR.** The main agent calls `dispatch_pr` to spin off a PR.
  Each PR subagent runs `pi` in its own `git worktree` + branch, in a tmux pane
  on the right, titled with its **PR number and name** once the PR is opened.
- **Worktree-based, always.** The main agent runs in the real repo and **never
  edits code** (the `edit`/`write` tools are disabled for it). All code changes
  happen in worktrees via subagents — so a single main session can run for the
  whole lifetime of a project.
- **Atomic commits, always.** PR subagents are instructed to commit after every
  coherent change, keeping git history crystal clear.
- **PR stacks & Graphite.** Tell the main agent to stack PRs and it dispatches
  with `mode: "stack"` (manual GitHub stacks) or `mode: "graphite"` (`gt`).
- **Two levels deep, max.** A PR subagent may spawn helper subagents
  (`dispatch_helper`) for focused sub-tasks in its worktree, but helpers cannot
  spawn anything further.
- **Check in & control.** `peek_pr_agent` reads a subagent's recent output to see
  its progress, `stop_pr_agent` interrupts or kills it, `send_to_pr_agent` steers
  it, `focus_pr_agent` jumps to its pane, and `list_pr_agents` / `/pr-agents`
  show every PR's number, name, branch and status. PR subagents get the same
  controls over their own helpers (`list_helpers`, `peek_helper`, `send_to_helper`,
  `stop_helper`).
- **Smart intake.** The main agent triages each request: a **one-off** task gets
  0–2 quick questions then straight to work; a **larger** task triggers planning
  — it thinks, asks you for detail, and iterates until you converge before
  dispatching anything.
- **`/cleanup`** removes worktrees, branches and panes for PRs that have merged
  or closed, and prunes orphaned worktrees.

## Companion packages (recommended)

This package detects and uses these if you install them:

```bash
pi install npm:pi-ask-user     # ask_user tool — used for triage & planning questions
pi install npm:pi-simplify     # /simplify — offered per-PR to tidy each diff
pi install npm:pi-web-access   # web_search / fetch_content — research while planning
pi install npm:pi-lens         # inline diagnostics + LSP/ast-grep in every worktree
```

- **pi-ask-user** — the orchestrator prefers `ask_user` for clarifying questions
  and decisions, and uses it to ask once whether PRs should run `/simplify`.
- **pi-simplify** — when you opt in, each PR subagent runs `/simplify` on its diff
  and commits the result before opening the PR (`dispatch_pr({ simplify: true })`,
  carried to the worker via `PI_PR_SIMPLIFY`).
- **pi-web-access** — available to the orchestrator and to PR/helper subagents.
- **pi-lens** — runs at each subagent's `session_start` inside its worktree; no
  setup needed. The main agent has `edit`/`write` disabled, which does not affect
  pi-lens at depth 0; subagents keep full tools so pi-lens behaves normally there.

## Requirements

- Run inside **tmux** (so PR panes can open beside the main agent):
  ```bash
  tmux new -s pr
  pi
  ```
- `git` (worktrees), and for opening PRs: `gh` (GitHub) and/or `gt` (Graphite).

### tmux auto-launch (optional)

Because the workflow needs tmux, the first time you start the main agent **outside**
tmux the package offers to install a shell `pi` wrapper that auto-launches pi inside
tmux from then on (inside tmux it just runs pi normally). You can run it any time:

```
/pr-install-tmux-alias
```

It writes an idempotent, marker-delimited block to `~/.zshrc`, `~/.bashrc`, or
`~/.config/fish/functions/pi.fish` depending on your shell. Set
`PI_PR_NO_ALIAS_PROMPT=1` to suppress the offer.

## Install

```bash
pi install npm:pi-pr-agents           # from npm
pi install git:github.com/anonx3247/pi-pr-agents   # from GitHub
pi install /path/to/pi-pr-agents      # local checkout
```

Then start pi inside tmux and just describe the work:

> "Add rate limiting to the API: a token-bucket limiter, wire it into the
> middleware, and add config. Split it into PRs."

The main agent loads the **pr-orchestrator** skill, proposes a PR breakdown, and
dispatches a subagent per PR.

## Tools

| Depth | Tool | Purpose |
|------|------|---------|
| main (0) | `dispatch_pr` | Create worktree+branch+pane and hand off one PR |
| main (0) | `list_pr_agents` | List PRs with number/name/branch/status |
| main (0) | `peek_pr_agent` | Read a subagent's recent pane output (progress) |
| main (0) | `focus_pr_agent` | Move tmux focus to a PR's pane |
| main (0) | `send_to_pr_agent` | Steer / answer a running PR subagent |
| main (0) | `stop_pr_agent` | Interrupt (Escape) or kill a PR subagent |
| main (0) | `cleanup_pr_worktrees` | Remove merged/closed PR worktrees |
| PR (1) | `set_pr_number` | Record the opened PR number (labels the pane) |
| PR (1) | `dispatch_helper` | Spawn a helper subagent in the same worktree |
| PR (1) | `list_helpers` / `peek_helper` / `send_to_helper` / `stop_helper` | Monitor & control helpers |
| helper (2) | — | none (cannot dispatch further) |

Commands: `/cleanup` (`/cleanup dry` to preview), `/pr-agents`.

## Skills

- **pr-orchestrator** — how the main agent decomposes work and dispatches PRs.
- **pr-worker** — how a PR subagent implements, commits atomically, and opens its PR.
- **pr-stacks** — manual GitHub stacks vs Graphite (`gt`) stacks.
- **cleanup** — tidying up merged/closed PR worktrees.

## How depth is enforced

Depth is carried across `pi` processes via the `PI_PR_DEPTH` environment
variable (main = 0, PR subagent = 1, helper = 2). The extension registers
different tools per level, so a helper simply has no way to dispatch.

## Shared state

The PR registry lives in `<git-common-dir>/pi-pr-agents/registry.json`, shared by
the main repo and every worktree, so each agent sees the same set of PRs.

## Configuration

- `PI_PR_ALLOW_MAIN_EDITS=1` — let the main agent keep `edit`/`write` (off by
  default; the orchestrator is meant to delegate, not edit).
- `PI_PR_NO_ALIAS_PROMPT=1` — don't offer to install the tmux `pi` wrapper.
- `PI_PR_DEPTH` / `PI_PR_SIMPLIFY` — set automatically on dispatched subagents;
  you don't set these by hand.

## Development

pi loads the `.ts` extension directly, so there is no build step. Contributors
just need the dev dependencies:

```bash
npm install
```

`npm install` also runs the `prepare` script, which registers a **pre-push git
hook** (via [`simple-git-hooks`](https://github.com/toplenboren/simple-git-hooks))
that runs the full gate — type-check, lint/format, and tests — before every
push. If you cloned before the hook existed, register it manually with:

```bash
npx simple-git-hooks
```

The same three checks run in CI (`.github/workflows/ci.yml`) on every push and
pull request:

```bash
npm run typecheck   # tsc --noEmit
npm run lint:ci     # biome ci .  (the gate — same script CI and the pre-push hook run)
npm test            # node:test suite via tsx

npm run lint        # biome check .  (ad-hoc local lint + format check)
npm run format      # biome format --write .  (apply formatting)
```

The pure, deterministic helpers in `extensions/pr-agents.ts` (slug/quote
formatting, registry round-trips, shell detection, etc.) are unit-tested with
Node's built-in test runner (`node:test`), executed straight from TypeScript via
[`tsx`](https://github.com/privatenumber/tsx) — no heavy test framework. Tests
live in `tests/` and are excluded from the published npm tarball.

## Publishing (maintainers)

The package is published to npm as [`pi-pr-agents`](https://www.npmjs.com/package/pi-pr-agents)
and listed in the [pi gallery](https://pi.dev/packages). pi loads the `.ts`
extension directly, so there is no build step.

```bash
npm login
npm publish            # uses files allowlist + public access from package.json
```

Or let CI do it: bump `version`, then push a matching tag and GitHub Actions
(`.github/workflows/publish.yml`) publishes with provenance.

```bash
npm version patch      # or minor/major; updates package.json + creates the tag
git push --follow-tags
```

Requires an `NPM_TOKEN` repo secret (an npm automation token).
