---
name: pr-stacks
description: How to build stacks of dependent pull requests, either as manual stacked GitHub PRs (each PR based on the previous branch) or as Graphite stacks managed with the gt CLI. Use when work must be split into PRs that build on each other, and you need to choose and drive a stacking strategy.
---

# PR Stacks

When several PRs depend on each other, ship them as a **stack** instead of one
giant PR. Two strategies are supported.

## Choosing a strategy

- Use **Graphite** (`gt`) if the repo/team already uses Graphite, or the user
  asks for "graphite". It automates restacking, submitting, and PR base updates.
  Check availability with `gt --version`.
- Otherwise use a **manual GitHub stack**: each PR's base is the previous PR's
  branch. Simpler, no extra tooling, but you restack by hand.

The orchestrator encodes this per PR via `dispatch_pr({ mode })`:
`"graphite"` or `"stack"` (vs `"independent"`).

## Manual GitHub stack

Dispatch PRs **in order**. Each one branches off the previous one's branch and
opens its PR against that branch:

- PR 1: base = `main`, branch = `pi/pr-a`
- PR 2: base = `pi/pr-a`, branch = `pi/pr-b`  (`dispatch_pr({mode:"stack", stack_on:"pi/pr-a"})`)
- PR 3: base = `pi/pr-b`, branch = `pi/pr-c`

Open each PR with `gh pr create --base <previous-branch> --head <branch>`.

**Restacking after a lower PR changes:** when PR 1's branch is updated, rebase the
ones above it:
```bash
git checkout pi/pr-b && git rebase pi/pr-a && git push --force-with-lease
git checkout pi/pr-c && git rebase pi/pr-b && git push --force-with-lease
```
When PR 1 merges into `main`, retarget PR 2 to `main` (`gh pr edit pi/pr-b --base main`)
and rebase it onto `main`.

## Graphite stack

```bash
# one-time, per repo
gt init            # if the repo isn't initialised for graphite yet

# build the stack — each branch on top of the last
gt track --parent main pi/pr-a       # register an existing branch, or…
gt create -m "feat: part A"          # …create a tracked branch from staged changes

# submit the whole stack as PRs (creates/updates PRs and their bases)
gt submit --no-interactive --stack

# after editing a lower branch, restack everything above it
gt restack
gt submit --no-interactive --stack
```

Key `gt` commands:
- `gt log` / `gt ls` — view the stack.
- `gt up` / `gt down` — move between branches in the stack.
- `gt modify` — amend the current branch and auto-restack descendants.
- `gt sync` — pull trunk, restack, and clean up merged branches.

## Rules for stacked work

- Keep each PR in the stack small and independently reviewable.
- Dispatch and merge **bottom-up**; never stack on an un-dispatched branch.
- After a stack lands, run `/cleanup` to remove merged worktrees/branches/panes,
  and `gt sync` (Graphite) to tidy the local stack.
