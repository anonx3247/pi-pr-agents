---
name: pr-worker
description: How a dedicated PR subagent implements its single pull request inside an isolated git worktree — making atomic commits on every change, verifying, opening the PR (plain GitHub or Graphite stack), and registering the PR number. Use this when you were dispatched as a PR subagent (PI_PR_DEPTH=1) to deliver one pull request.
---

# PR Worker

You are the subagent responsible for **one pull request**. You run in an isolated
git worktree on branch `$PI_PR_BRANCH`, branched from `$PI_PR_BASE`, in mode
`$PI_PR_MODE`. Your tmux pane is watched by the main orchestrator.

## Atomic commits — always

This is the most important rule. After **every** coherent, self-contained change:

```bash
git add -A
git commit -m "<type>: <concise description>"
```

- Make many small commits, not one big one. The history must read clearly to any
  other agent or reviewer.
- Keep each commit green: run the relevant build/tests/linters first.
- Use conventional commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`,
  `docs:`, `chore:`).
- Never `git commit --amend` a commit you have already pushed.

## Steps

1. **Implement** the task, committing atomically as you go.
2. **Verify**: run the project's tests/build/lint. Fix and re-commit until green.
3. **Simplify (if requested)**: if `PI_PR_SIMPLIFY=1` (the orchestrator opted in),
   call the `simplify_diff` tool; it returns a simplification task (the changed
   files vs your PR base + guidance) as its result. Apply those simplifications
   **in the same turn**, run tests, commit them as an atomic `refactor: simplify`
   commit, then continue. Do **not** sleep/poll or expect a separate command to
   run. Requires pi-simplify.
4. **Push and open the PR**, according to your mode:

   ### mode = independent  (plain GitHub PR off the base branch)
   ```bash
   git push -u origin "$PI_PR_BRANCH"
   gh pr create --base "$PI_PR_BASE" --head "$PI_PR_BRANCH" \
     --title "$PI_PR_NAME" --fill
   ```

   ### mode = stack  (manual stacked GitHub PR)
   Your base (`$PI_PR_BASE`) is the *previous* PR's branch. Open the PR against it:
   ```bash
   git push -u origin "$PI_PR_BRANCH"
   gh pr create --base "$PI_PR_BASE" --head "$PI_PR_BRANCH" \
     --title "$PI_PR_NAME" --fill
   ```
   See the `pr-stacks` skill for keeping manual stacks in sync after a rebase.

   ### mode = graphite  (Graphite stack via gt)
   Your branch already exists on top of `$PI_PR_BASE`. Track it with Graphite and
   submit:
   ```bash
   gt track --parent "$PI_PR_BASE" "$PI_PR_BRANCH"   # if not already tracked
   gt submit --no-interactive --stack
   ```
   (Or, if you are creating the branch through Graphite from scratch, use
   `gt create -m "<message>"` per commit instead of raw `git commit`.) See the
   `pr-stacks` and `gt-graphite` skills.

5. **Signal the PR as pushed** (final step) so your pane and the orchestrator are
   labelled AND the orchestrator starts polling the PR for merge/close:
   ```
   pr_pushed({ prNumber: <the PR number>, url: "<the PR url>" })
   ```
   Get the number/url from the `gh pr create` / `gt submit` output, or
   `gh pr view --json number,url`. Call `pr_pushed` only once the branch is
   actually pushed and the PR exists. (The older `set_pr_number` tool still works
   for labelling, but `pr_pushed` is the documented final step.)

6. **Report back** with a concise summary: branch, PR number/url, the commits you
   made, how you verified, and any follow-up PRs you recommend the orchestrator
   split off.

## Review-comment loop (stay available after opening the PR)

After you open the PR, **stay alive** — do not consider the pane disposable. A
background poller (every ~30s, only once your PR is pushed and numbered) watches
your PR for new reviewer feedback. When new inline review comments arrive it
hands you a fresh task that lists each comment and asks you to:

1. Address each comment with code changes.
2. Run the gate (`npm run typecheck && npm run lint:ci && npm test`) and commit
   (e.g. `fix: address review feedback`).
3. Push with `git push`.
4. **Reply to each inline thread** with the `reply_to_review_comment` tool
   (`commentId` = the numeric id from `rc:<id>`, `body` = a short explanation of
   your fix or a clarifying question).

Replies do **not** resolve threads — leave resolving to the human reviewer. If a
comment is ambiguous or architectural, reply asking for clarification rather than
guessing. (Known limitation: this only works while your pane/process is alive; if
it was already cleaned up, new comments won't be auto-handled.)

## CI-failure loop (auto-fix when checks fail)

The same background poller also watches your PR's **CI checks**. When a check
fails on your PR's head commit it hands you a fresh task listing each failing
check and asks you to:

1. Reproduce the failure locally by running the gate
   (`npm run typecheck && npm run lint:ci && npm test`).
2. Fix the cause, commit (e.g. `fix: resolve CI failure`), and `git push`.
3. If the failure is environment-specific or unclear from the gate, inspect logs
   with `gh run view --log-failed` (find the run via `gh run list --branch <branch>`).

**Never disable or weaken checks to make CI pass.** Failures are deduped once per
commit (key `ci:<headSha>:<name>`), so after you push a fix a still-failing check
re-notifies (new sha) and a passing run never does. Same known limitation: this
only runs while your pane/process is alive.

## Helpers (optional, one level only)

For a focused sub-task you may spawn a helper in this same worktree:
```
dispatch_helper({ name: "review", task: "Review the diff for edge cases and report findings." })
```
Monitor and steer your helpers just like the orchestrator monitors you:
`list_helpers`, `peek_helper({id})` (read its progress), `send_to_helper({id, message})`,
and `stop_helper({id, mode})` (interrupt or kill). Helpers cannot spawn further agents.

## Available companion tools

- **pi-web-access** — `web_search` / `fetch_content` / `code_search` for docs and
  research while implementing.
- **pi-lens** — inline diagnostics and LSP/ast-grep navigation; active in this
  worktree automatically. Heed its feedback.
- **pi-simplify** — powers the inline `simplify_diff` task (see step 3 above).

## Boundaries

- Stay in this worktree and on this branch. Do not touch other branches/worktrees
  or the main checkout.
- Do only this PR's work. Note any out-of-scope discoveries in your final summary.
- If you are blocked or unsure, state the question in your output; the orchestrator
  can send instructions into your pane.
