---
name: cleanup
description: Clean up stale git worktrees, branches and tmux panes for PRs that have been merged or closed. Use when PRs have landed, when the user runs /cleanup, or when you want to tidy the PR-agent workspace. Only the main orchestrator agent should run cleanup.
---

# Cleanup

Removes the leftovers of finished PR work: worktrees, local branches, and tmux
panes for PRs that are now **merged** or **closed**, plus any orphaned worktrees
under the `*.worktrees/` directory.

## How to run

- Slash command: `/cleanup` (add `dry` to preview, e.g. `/cleanup dry`).
- Or the tool: `cleanup_pr_worktrees({ dry_run: true })` to preview, then
  `cleanup_pr_worktrees({})` to apply.

## What it does

For every PR subagent in the registry:
1. Determine if it is finished:
   - if it has a PR number, ask GitHub via `gh pr view <n> --json state`
     (MERGED / CLOSED → finished);
   - otherwise check whether its branch is merged into the default branch.
2. If finished: kill its tmux pane, `git worktree remove --force` its worktree,
   delete its local branch, and drop it from the registry.
3. It then prunes any orphaned `*.worktrees/` directories and runs
   `git worktree prune`.

Active PRs (still open, branch not merged) are left untouched and reported.

## Notes

- Run this from the **main repo** as the orchestrator agent, not from inside a
  worktree.
- `gh` is used for PR state. Without it, cleanup falls back to "branch merged into
  the default branch" detection only.
- For Graphite stacks you can additionally run `gt sync` to clean up merged
  branches that Graphite tracks.
