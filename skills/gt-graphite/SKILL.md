---
name: gt-graphite
description: How to drive Graphite's `gt` CLI to create, visualize, navigate, sync, submit, and merge stacks of dependent pull requests. Use whenever working in a Graphite-enabled repo or when dispatch_pr mode is "graphite" — covers the stacking mental model, automatic restacking/rebasing, how stacks merge, and the full command reference.
---

# Graphite (`gt`)

Graphite's `gt` CLI does two things: it **simplifies git** (especially rebasing),
and it lets you build **stacks of pull requests**. This skill teaches the mental
model and the full command reference so an agent can drive `gt` confidently.

## Mental model

- A **stack** is a sequence of PRs, each built on top of its parent. Every PR is
  small, so it can be tested, reviewed, and merged independently — and the next
  PR doesn't have to wait for the one below it to land.
- **trunk** is the main/master branch. You configure it once with `gt init`
  (stored in `.git/.graphite_repo_config`). `gt` needs trunk so it knows where
  PRs merge into and how to sync from `origin`.
- **PRs are a higher level of abstraction than commits — not a replacement for
  them.** Commits record the *edit history* (every small decision and bugfix); a
  PR/branch records a *step of the implementation* (a milestone). In Graphite you
  still commit normally — you just split the work into a sequence of small
  branches, one per logical step, and each branch can hold as many commits as it
  takes to get that step right.
  - **downstack** = toward trunk (a branch's ancestors / parents).
  - **upstack** = away from trunk (a branch's descendants / children).
- **Automatic restacking is the key idea.** When you edit a branch lower in the
  stack (e.g. with `gt modify`), Graphite automatically rebases ("restacks")
  every branch above it onto the new changes. **You do not rebase by hand.** This
  is the whole point — keep editing low branches and trust `gt` to keep the
  upstack consistent.

## Lifecycle

### Initialize (once per repo)

```bash
gt init                  # interactive; pick trunk
gt init --trunk main     # non-interactive
```

### Create a branch for each step

You still commit as normal — `gt create` makes a new tracked branch **and**
commits your staged changes onto it in one step. Make your changes on top of the
current branch, then create the branch from them. **Don't** pre-create an empty
branch — change first, then `gt create`. Add further commits to the same branch
as you iterate with `gt modify`.

```bash
gt add -A                       # stage, then…
gt create -m "feat: part 1"     # create a branch + commit; name inferred from message
# or in one step:
gt create -am "feat: part 1"    # -a stages all tracked+untracked, -m sets the message
```

Stack more branches the same way — each builds on the current one:

```bash
gt create -am "feat: part 2"
gt create -am "feat: part 3"
```

### Submit (open/update PRs)

`gt submit` force-pushes the current branch **and everything downstack** and
creates/updates one PR per branch, with each PR's base pointing at its parent.

```bash
gt submit                              # current branch + downstack
gt submit --stack                      # alias: gt ss — also include descendants (whole stack)
gt submit --stack --reviewers alice --draft
gt submit --no-interactive --update-only   # -u: don't create new PRs, just update existing
gt submit --dry-run                    # preview
```

Useful flags: `-r/--reviewers`, `-d/--draft`, `--no-interactive`,
`-u/--update-only`, `--dry-run`, `-c/--confirm`. `gt submit` validates that
everything is restacked and **fails on conflicts**.

> In pi-pr-agents the **main agent** runs `gt submit --stack` so the whole stack
> is created/updated together — that is what keeps every PR's base correct **and
> updates the Graphite web UI**. See *Using `gt` with pi-pr-agents* below.

### Address review feedback on a lower branch

Check out the branch, edit, then let `gt modify` amend its commit and auto-restack
everything above it:

```bash
gt checkout pi/pr-a       # or: gt co pi/pr-a
# …edit files…
gt modify                 # amend the commit + restack all descendants
gt modify -cam "fix: address review"   # instead add a NEW commit + restack
```

The manual git equivalent would be `git commit --amend` followed by `gt restack` —
but prefer `gt modify`, which does both. Re-`gt submit --stack` to push the
updates.

### Sync with trunk

```bash
gt sync
```

`gt sync` pulls the latest trunk, **restacks (rebases) all open PRs** onto the new
trunk, and prompts you to delete local branches whose PRs have merged or closed.
If a restack hits conflicts, `gt sync` prompts you to checkout the branch and run
`gt restack` to resolve.

### Merge the stack

Open the top PR and merge from the Graphite UI, or use `gt merge`:

```bash
gt top        # gt t — jump to the top branch
gt pr         # open its PR in the browser
# …merge in the Graphite UI…
gt merge      # or: merge the PRs from trunk up to the current branch via Graphite
```

**How stacks merge:** clicking Merge on a stack merges the PRs **in order from the
bottom** (closest to trunk) **upward**. You can merge only the lower part of a
stack by merging from a chosen PR; the remaining upstack PRs are **re-pointed
automatically** so their bases stay correct. Merging is always bottom-up, and
Graphite keeps PR bases updated as lower PRs land.

### Clean up after merge

```bash
gt sync       # fetch, detect merged/closed branches, prompt-delete them, rebase the rest
```

## Visualize

```bash
gt log              # detailed graph: metadata + PR links/status (once submitted)
gt log short        # gt ls — compact branch list, current branch marked
gt log long         # gt ll — raw git history
gt info             # one branch's info
```

`log` / `log short` flags: `-s/--stack` (only ancestors+descendants of current),
`-n/--steps <n>` (implies `--stack`, n levels each way), `-r/--reverse` (trunk at
top), `-a/--all`, `-u/--show-untracked`. `gt info [branch]` takes `-b/--body`,
`-d/--diff`, `-p/--patch`, `-s/--stat`.

## Navigate

```bash
gt checkout [branch]   # gt co — interactive selector if no branch given
gt up [n]              # gt u — toward descendants (upstack)
gt down [n]            # gt d — toward parent/trunk (downstack)
gt top                 # gt t — top of the stack
gt bottom              # gt b — lowest NON-trunk branch
gt parent              # the parent branch
gt children            # the child branches
gt trunk               # the trunk branch
```

`gt checkout` flags: `-s/--stack`, `-t/--trunk`, `-a/--all`, `-u/--show-untracked`.
To check out trunk itself use `gt checkout -t` (note `gt bottom` stops at the
lowest non-trunk branch).

## Reorganize / edit a stack

```bash
gt move --onto <parent>     # rebase current branch onto a new parent + restack descendants
                            #   (also --source, --only)
gt fold                     # merge current branch into its parent + restack (--keep, --close, --stack)
gt pop                      # delete current branch, KEEP its working-tree changes
gt reorder                  # editor to reorder branches between trunk and current + restack
gt split --by-commit        # gt sp — split a branch (--by-hunk, --by-file <pathspec>)
gt squash                   # gt sq — squash a branch's commits (--message, --no-edit)
gt absorb                   # gt ab — distribute staged hunks into the right downstack commits
                            #   (-a, -d/--dry-run, -p) + restack upstack
```

## Tracking & collaboration

```bash
gt track [branch]      # gt tr — start tracking an existing git branch (choose its parent)
                       #   --parent <b>, --force; also fixes corrupted metadata
gt untrack [branch]    # gt utr — stop tracking (--force)
gt get [branch]        # fetch a teammate's stack or a PR number locally
                       #   --downstack/-d, --remote-upstack/-u, --restack, --force,
                       #   --delete-all, --no-checkout
gt freeze [branch]     # prevent local edits (incl. restacks) — e.g. stacking on someone else's PR
gt unfreeze [branch]   # allow edits again
```

A frozen branch can still be updated via `gt sync`/`gt get`, and you can still
build PRs on top of it.

## Recovery & conflict handling

```bash
gt restack             # rebase each branch in the stack onto its parent
                       #   -d/--downstack, -u/--upstack, -o/--only, --branch
gt continue            # resume a gt command halted by a conflict (-a stages all first)
gt abort               # cancel the in-progress gt operation
gt undo                # revert the most recent Graphite mutation
```

On a conflict you get an interactive git rebase; resolve it, then `gt continue`.
`gt restack` skips branches checked out in other worktrees.

## Command reference

| Command | Alias | What it does |
|---|---|---|
| `gt create` | `gt c` | Create a tracked branch from staged changes |
| `gt modify` | `gt m` | Amend (or `-c` add) commit + auto-restack descendants |
| `gt submit --stack` | `gt ss` | Open/update one PR per branch in the stack |
| `gt checkout` | `gt co` | Switch branches (interactive if no arg) |
| `gt up` | `gt u` | Move toward descendants |
| `gt down` | `gt d` | Move toward parent/trunk |
| `gt top` | `gt t` | Jump to top of stack |
| `gt bottom` | `gt b` | Jump to lowest non-trunk branch |
| `gt log short` | `gt ls` | Compact stack view |
| `gt log long` | `gt ll` | Raw git history |
| `gt split` | `gt sp` | Split a branch |
| `gt squash` | `gt sq` | Squash a branch's commits |
| `gt absorb` | `gt ab` | Distribute staged hunks downstack |
| `gt track` | `gt tr` | Track an existing branch |
| `gt untrack` | `gt utr` | Stop tracking a branch |

Global flags: `--no-interactive`, `--quiet` (implies `--no-interactive`),
`--no-verify`, `--cwd <dir>`, `--debug`.

Official docs: <https://graphite.com/docs/command-reference> and
<https://graphite.com/docs/cli-quick-start>.

## Using `gt` with pi-pr-agents

In pi-pr-agents **every branch gets its own git worktree**:
`dispatch_pr({ mode: "graphite", stack_on: "<prev PR/branch>" })` runs
`git worktree add -b <branch> <worktree> <base>`, branching each PR off the
previous PR's branch. So the branches are created **separately** (by git, one per
worktree) and then **tracked and restacked** with `gt` — Graphite doesn't have to
build them all in a single checkout.

### Main agent (orchestrator) — owns the stack

Working in the main repo, the orchestrator:

- runs `gt init` once if the repo isn't initialised;
- dispatches Graphite PRs **bottom-up**, each `stack_on` the previous branch, and
  never stacks on an un-dispatched branch;
- runs `gt submit --no-interactive --stack` to create/update the **whole** stack
  at once — this keeps every PR's base correct **and updates the Graphite web
  UI**;
- owns all cross-stack operations — `gt restack`, `gt sync`, `gt merge`,
  navigation (`gt up`/`down`/`checkout`) and reorg (`gt move`/`reorder`/…);
- merges **bottom-up**, then after the stack lands runs `/cleanup` (pi-pr-agents)
  for worktrees/branches/panes and `gt sync` to delete merged branches locally.

### PR-worker (subagent) — stays in its own branch worktree

A worker does **not** navigate or reorganise the stack, and does **not** run
`gt create` (its branch already exists). It just registers its branch with
Graphite and submits **its own** branch:

```bash
gt track --parent "$PI_PR_BASE" "$PI_PR_BRANCH"   # if not already tracked
gt submit --no-interactive                         # its own branch (base = $PI_PR_BASE)
```

Iterate on review feedback with `gt modify` (amend) or `gt modify -cam "msg"`
(new commit). **Never hand-rebase.** Note that `gt restack`/`gt modify` **skip
branches checked out in other worktrees**, so cross-branch restacking after a
lower PR changes is coordinated by the **main agent's** `gt submit --stack`, not
by the worker.

> **Open design question (out of scope for this docs PR):** `mode: "graphite"`
> already exists on `dispatch_pr` (the GitHub modes are `independent`/`stack`).
> Whether to add a project-level stored setting (e.g. in `project/.pi`) that
> selects GitHub vs Graphite and prompts the user is a reasonable follow-up.

**Non-interactive note:** in automated/subagent contexts always pass
`--no-interactive` (or `--quiet`) and avoid commands that need an interactive
editor/selector (e.g. `gt reorder`, bare `gt checkout`) unless you give them
explicit arguments.
