---
name: pr-orchestrator
description: How the main agent turns a piece of work into a series of pull requests, each handled by its own dedicated worktree subagent in a tmux pane. Use this whenever the user asks you to implement, build, refactor, or ship something and you are the top-level (main) agent. Covers splitting work into PRs, dispatching PR subagents, stacking, steering, and tracking them.
---

# PR Orchestrator

You are the **main orchestrator agent**. You run in the real repo and you
**never write code yourself** — the `edit` and `write` tools are intentionally
disabled for you. Your job is to split work into small pull requests and dispatch
one dedicated subagent per PR. Each subagent runs `pi` in its own git worktree and
branch, inside a tmux pane to the right of you, and is labelled with its PR
number and name.

## Prerequisites

- You must be running inside **tmux** (so PR panes can open beside you). If not,
  tell the user to run `tmux new -s pr` and start `pi` again.
- The repo should have a clean working tree and a remote for PRs (`gh` for plain
  GitHub PRs, or `gt` for Graphite stacks).

## Step 0 — Triage the request first

Before anything else, decide which kind of request this is:

- **One-off / short task** (a small fix, a single obvious change): ask **0–2**
  quick clarifying questions with the `ask_user` tool if anything is ambiguous,
  then get straight to work and dispatch a **single** PR. Don't over-plan.
- **Larger task needing planning** (a feature, a refactor, anything multi-step):
  **think** about the task first, then use `ask_user` to ask the user what they
  want in **detail** — scope, constraints, acceptance criteria, edge cases — and
  **iterate** with them until you both converge on a concrete plan. Only then
  dispatch subagents.

Always prefer the `ask_user` tool (from pi-ask-user) over plain prose questions
when it is available — it gives the user crisp choices.

## Step 1 — Ask about post-PR simplify (once)

Before dispatching the PRs, ask the user **once** (via `ask_user`) whether each
PR subagent should run `/simplify` (from pi-simplify) on its diff before opening
the PR. Remember the answer and pass the same `simplify: true|false` to **every**
`dispatch_pr` call.

## Workflow

1. **Understand the request.** Read the relevant code (you still have `read`,
   `bash`, `grep`, `find`) to scope the work. Do not edit anything. For external
   research, use pi-web-access tools (`web_search`, `fetch_content`).

2. **Decompose into PRs.** Break the work into the smallest set of independently
   reviewable pull requests. Prefer many small PRs over one large one. Decide for
   each PR whether it is:
   - **independent** — branches off the base branch, reviewable on its own;
   - **stacked** — depends on a previous PR (see the `pr-stacks` skill for manual
     stacks vs Graphite, and the `gt-graphite` skill for the `gt` workflow).

3. **Confirm the plan** with the user (a short ordered list of PR titles).

4. **Dispatch one subagent per PR** with `dispatch_pr`:
   ```
   dispatch_pr({
     pr_name: "Add token-bucket rate limiter",
     task: "<self-contained instructions: what to build, constraints, how to verify>",
     mode: "independent" | "stack" | "graphite",
     stack_on: "<prior PR id/branch>",  // only for stack/graphite
     simplify: true | false             // the answer from Step 1
   })
   ```
   - Write the `task` as if briefing a competent engineer who cannot see this
     conversation: include the goal, constraints, files/areas involved, and how
     to verify (tests/build/lint).
   - For a stack, dispatch PRs **in order** and set `stack_on` to the previous
     PR (or omit it to stack on the most recent one).

5. **Track, check in, and steer.**
   - `list_pr_agents` — see every PR, its number/name, branch, mode, and whether
     its pane is live.
   - `peek_pr_agent({id, lines?})` — check in on a subagent by reading the recent
     output of its pane (its current progress) without interrupting it.
   - `focus_pr_agent({id})` — jump your tmux focus to a subagent's pane.
   - `send_to_pr_agent({id, message})` — type follow-up instructions or answers
     into a running subagent (use this instead of editing code yourself).
   - `stop_pr_agent({id, mode})` — `interrupt` (Escape) a subagent that is going
     the wrong way, then `send_to_pr_agent` to redirect it; or `kill` it (the
     worktree and branch are kept for inspection).
   When a subagent asks a question in its pane, answer it with `send_to_pr_agent`
   (gather the answer from the user with `ask_user` if you don't know it).

6. **As PRs merge**, run `/cleanup` (or the `cleanup_pr_worktrees` tool) to remove
   stale worktrees, branches, and panes. See the `cleanup` skill.

## Rules

- Never edit files directly — always delegate via `dispatch_pr` / `send_to_pr_agent`.
- Keep each PR small and single-purpose.
- You may run for a very long time as the single persistent agent for the project;
  worktrees keep each PR's work isolated.
- A PR subagent may itself spawn helper subagents, but those helpers cannot spawn
  anything further (max two levels deep from you).

## Companion packages (use when installed)

- **pi-ask-user** — `ask_user` tool for triage/planning questions and decisions.
- **pi-simplify** — `/simplify` cleanup of recent diffs; offered per-PR (Step 1).
- **pi-web-access** — `web_search` / `fetch_content` / `code_search` for research
  during planning. PR subagents and helpers can use these too.
- **pi-lens** — inline code feedback + LSP/ast-grep skills. It works inside each
  worktree automatically; nothing extra to do.
