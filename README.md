# @anas/pi-pr-agents

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
- **Easy navigation.** `focus_pr_agent` jumps to a pane, `send_to_pr_agent`
  types follow-up instructions into a running subagent, `list_pr_agents` /
  `/pr-agents` show every PR's number, name, branch and status.
- **`/cleanup`** removes worktrees, branches and panes for PRs that have merged
  or closed, and prunes orphaned worktrees.

## Requirements

- Run inside **tmux** (so PR panes can open beside the main agent):
  ```bash
  tmux new -s pr
  pi
  ```
- `git` (worktrees), and for opening PRs: `gh` (GitHub) and/or `gt` (Graphite).

## Install

```bash
pi install /path/to/pi-pr-agents      # local
# or, once published:
# pi install npm:@anas/pi-pr-agents
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
| main (0) | `focus_pr_agent` | Move tmux focus to a PR's pane |
| main (0) | `send_to_pr_agent` | Steer / answer a running PR subagent |
| main (0) | `cleanup_pr_worktrees` | Remove merged/closed PR worktrees |
| PR (1) | `set_pr_number` | Record the opened PR number (labels the pane) |
| PR (1) | `dispatch_helper` | Spawn a helper subagent in the same worktree |
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
