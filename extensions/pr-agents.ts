/**
 * pr-agents.ts — Graphite / PR-stack orchestration for pi.
 *
 * Model
 * -----
 * - The MAIN agent (depth 0) runs in the real repo. It never writes code. It
 *   splits work into PRs and dispatches one dedicated subagent per PR.
 * - Each PR subagent (depth 1) runs `pi` in its own git worktree + branch,
 *   inside a labelled tmux pane to the right of the main agent. It commits
 *   atomically and opens a PR (plain GitHub or a Graphite stack).
 * - A PR subagent MAY spawn helper subagents (depth 2) in the same worktree,
 *   but those helpers cannot dispatch anything further (max 2 levels deep).
 *
 * Depth is carried across `pi` processes via the PI_PR_DEPTH env var.
 * Shared state lives in <git-common-dir>/pi-pr-agents/registry.json so the main
 * repo and every worktree see the same registry.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const WORKER_PROMPT = path.join(PKG_ROOT, "assets", "worker-system.md");
const HELPER_PROMPT = path.join(PKG_ROOT, "assets", "helper-system.md");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function depth(): number {
  const n = Number.parseInt(process.env.PI_PR_DEPTH ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function insideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "pr"
  );
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 30000 }).toString().trim();
}

function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { stdio: "pipe", timeout: 10000 }).toString().trim();
}

function tryTmux(args: string[]): string | null {
  try {
    return tmux(args);
  } catch {
    return null;
  }
}

function repoRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

function gitCommonDir(cwd: string): string {
  const d = git(["rev-parse", "--git-common-dir"], cwd);
  return path.resolve(cwd, d);
}

function defaultBranch(cwd: string): string {
  const head = tryGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (head) return head.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (tryGit(["rev-parse", "--verify", b], cwd)) return b;
  }
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

// ---------------------------------------------------------------------------
// Registry (shared across worktrees)
// ---------------------------------------------------------------------------

interface PrEntry {
  id: string;
  prName: string;
  branch: string;
  base: string;
  mode: "independent" | "stack" | "graphite";
  paneId: string;
  worktree: string;
  depth: number;
  parentId: string;
  prNumber?: number;
  prUrl?: string;
  status: "working" | "open" | "merged" | "closed";
  createdAt: string;
}

function registryPath(cwd: string): string {
  const dir = path.join(gitCommonDir(cwd), "pi-pr-agents");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "registry.json");
}

function loadRegistry(cwd: string): PrEntry[] {
  try {
    const raw = fs.readFileSync(registryPath(cwd), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRegistry(cwd: string, entries: PrEntry[]): void {
  fs.writeFileSync(registryPath(cwd), JSON.stringify(entries, null, 2));
}

function updateEntry(cwd: string, id: string, patch: Partial<PrEntry>): PrEntry | undefined {
  const entries = loadRegistry(cwd);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return undefined;
  entries[idx] = { ...entries[idx], ...patch };
  saveRegistry(cwd, entries);
  return entries[idx];
}

function findEntry(entries: PrEntry[], ref: string): PrEntry | undefined {
  return entries.find(
    (e) =>
      e.id === ref ||
      e.id.startsWith(ref) ||
      e.branch === ref ||
      e.prName === ref ||
      (e.prNumber !== undefined && String(e.prNumber) === ref.replace(/^#/, "")),
  );
}

// ---------------------------------------------------------------------------
// tmux pane management
// ---------------------------------------------------------------------------

function tmuxSetup(): void {
  // Show pane titles so PR panes can be labelled with their PR number/name.
  tryTmux(["set", "-g", "pane-border-status", "top"]);
  tryTmux(["set", "-g", "pane-border-format", " #{pane_title} "]);
}

function paneTitle(entry: Pick<PrEntry, "prNumber" | "prName" | "branch">): string {
  const tag = entry.prNumber !== undefined ? `PR#${entry.prNumber}` : "PR";
  return `${tag} ${entry.prName} (${entry.branch})`;
}

function paneAlive(paneId: string): boolean {
  const out = tryTmux(["list-panes", "-a", "-F", "#{pane_id}"]);
  if (!out) return false;
  return out.split("\n").includes(paneId);
}

/**
 * Open a new pane running `command` (a shell string) in `cwd`, label it, and
 * re-tile so the dispatching agent stays large on the left (main-vertical).
 */
function openPane(cwd: string, command: string, title: string): string {
  const paneId = tmux([
    "split-window",
    "-h",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-c",
    cwd,
    command,
  ]);
  tryTmux(["select-pane", "-t", paneId, "-T", title]);
  // Keep the orchestrator pane dominant on the left, PR panes stacked right.
  tryTmux(["set-window-option", "-t", paneId, "main-pane-width", "55%"]);
  tryTmux(["select-layout", "-t", paneId, "main-vertical"]);
  return paneId;
}

function setPaneTitle(paneId: string, title: string): void {
  tryTmux(["select-pane", "-t", paneId, "-T", title]);
}

// ---------------------------------------------------------------------------
// Launch commands
// ---------------------------------------------------------------------------

function buildEnv(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}=${shq(v)}`)
    .join(" ");
}

function buildWorkerCommand(entry: PrEntry, task: string): string {
  const env = buildEnv({
    PI_PR_DEPTH: "1",
    PI_PR_ID: entry.id,
    PI_PR_MODE: entry.mode,
    PI_PR_BASE: entry.base,
    PI_PR_BRANCH: entry.branch,
    PI_PR_NAME: entry.prName,
  });
  const flags = [
    "--name",
    shq(`PR: ${entry.prName}`),
  ];
  if (fs.existsSync(WORKER_PROMPT)) {
    flags.push("--append-system-prompt", shq(WORKER_PROMPT));
  }
  // Keep the pane (and pi) alive even after the session ends so the human can
  // inspect / resume; `; exec $SHELL` drops to a shell when pi exits.
  return `${env} pi ${shq(task)} ${flags.join(" ")}; exec ${process.env.SHELL || "bash"}`;
}

function buildHelperCommand(parentId: string, name: string, task: string): string {
  const env = buildEnv({
    PI_PR_DEPTH: "2",
    PI_PR_ID: parentId,
    PI_PR_HELPER: name,
  });
  const flags = ["--name", shq(`helper: ${name}`)];
  if (fs.existsSync(HELPER_PROMPT)) {
    flags.push("--append-system-prompt", shq(HELPER_PROMPT));
  }
  return `${env} pi ${shq(task)} ${flags.join(" ")}; exec ${process.env.SHELL || "bash"}`;
}

// ---------------------------------------------------------------------------
// Worktree helpers
// ---------------------------------------------------------------------------

function worktreesDir(cwd: string): string {
  const root = repoRoot(cwd);
  const name = path.basename(root);
  return path.join(path.dirname(root), `${name}.worktrees`);
}

function uniqueBranch(cwd: string, desired: string): string {
  let branch = desired;
  let i = 2;
  while (tryGit(["rev-parse", "--verify", "--quiet", branch], cwd) !== null) {
    branch = `${desired}-${i}`;
    i += 1;
  }
  return branch;
}

// ---------------------------------------------------------------------------
// Cleanup logic (shared by tool + /cleanup command)
// ---------------------------------------------------------------------------

interface CleanupResult {
  removed: string[];
  kept: string[];
  lines: string[];
}

function branchMerged(cwd: string, branch: string, base: string): boolean {
  const merged = tryGit(["branch", "--merged", base, "--format=%(refname:short)"], cwd);
  if (!merged) return false;
  return merged.split("\n").map((s) => s.trim()).includes(branch);
}

function prState(cwd: string, number: number): string | null {
  // Requires gh; returns MERGED / CLOSED / OPEN or null if unavailable.
  try {
    return execFileSync("gh", ["pr", "view", String(number), "--json", "state", "-q", ".state"], {
      cwd,
      stdio: "pipe",
      timeout: 15000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function runCleanup(cwd: string, dryRun: boolean): CleanupResult {
  const root = repoRoot(cwd);
  const base = defaultBranch(cwd);
  const entries = loadRegistry(cwd);
  const removed: string[] = [];
  const kept: string[] = [];
  const lines: string[] = [];
  const survivors: PrEntry[] = [];

  // 1. Registry-tracked PR agents whose PR is merged/closed or branch merged.
  for (const e of entries) {
    let reason = "";
    if (e.prNumber !== undefined) {
      const state = prState(root, e.prNumber);
      if (state === "MERGED" || state === "CLOSED") reason = `PR #${e.prNumber} ${state.toLowerCase()}`;
    }
    if (!reason && branchMerged(root, e.branch, base)) reason = `branch merged into ${base}`;

    if (!reason) {
      survivors.push(e);
      kept.push(`${e.prName} (${e.branch}) — still active`);
      continue;
    }

    lines.push(`${dryRun ? "would remove" : "removing"} ${e.prName} (${e.branch}) — ${reason}`);
    removed.push(e.branch);
    if (!dryRun) {
      if (paneAlive(e.paneId)) tryTmux(["kill-pane", "-t", e.paneId]);
      tryGit(["worktree", "remove", "--force", e.worktree], root);
      tryGit(["branch", "-D", e.branch], root);
    }
  }

  // 2. Orphaned worktrees that the registry no longer tracks.
  const wtList = tryGit(["worktree", "list", "--porcelain"], root) ?? "";
  for (const block of wtList.split("\n\n")) {
    const m = block.match(/^worktree (.+)$/m);
    if (!m) continue;
    const wt = m[1];
    if (wt === root) continue;
    if (!wt.includes(`.worktrees${path.sep}`) && !wt.includes(".worktrees/")) continue;
    if (survivors.some((s) => s.worktree === wt)) continue;
    if (removed.some((b) => wtList.includes(b))) {
      /* already handled by branch removal */
    }
    if (entries.some((e) => e.worktree === wt)) continue; // handled above
    if (!fs.existsSync(wt)) continue;
    lines.push(`${dryRun ? "would prune" : "pruning"} orphan worktree ${wt}`);
    removed.push(wt);
    if (!dryRun) tryGit(["worktree", "remove", "--force", wt], root);
  }

  if (!dryRun) {
    tryGit(["worktree", "prune"], root);
    saveRegistry(cwd, survivors);
  }

  return { removed, kept, lines };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const level = depth();

  // ---- Common: tidy tmux titles when we're inside tmux ----------------
  pi.on("session_start", async (_event, ctx) => {
    if (insideTmux()) tmuxSetup();

    // The main agent never writes code directly: disable edit/write at depth 0
    // unless explicitly opted out. It orchestrates; subagents do the writing.
    if (level === 0 && !process.env.PI_PR_ALLOW_MAIN_EDITS) {
      const active = pi.getActiveTools().filter((t) => t !== "edit" && t !== "write");
      pi.setActiveTools(active);
    }
    void ctx;
  });

  // =====================================================================
  // DEPTH 0 — the main orchestrator
  // =====================================================================
  if (level === 0) {
    pi.registerTool({
      name: "dispatch_pr",
      label: "Dispatch PR agent",
      description:
        "Split off one PR of work and hand it to a dedicated subagent. Creates a git worktree + branch, opens a labelled tmux pane running `pi`, and seeds it with the task. The subagent commits atomically and opens the PR. Use mode 'independent' for a standalone PR off the base branch, 'stack' to stack a manual PR onto the previous one, or 'graphite' to build a Graphite stack with `gt`.",
      promptSnippet:
        "Hand one PR-sized chunk of work to its own worktree subagent in a tmux pane.",
      promptGuidelines: [
        "Use dispatch_pr to delegate every code change — the main agent must not edit files itself.",
        "Use dispatch_pr once per PR, splitting large work into a sequence of small, reviewable PRs.",
        "Use dispatch_pr with mode 'stack' or 'graphite' (and stack_on) when PRs build on each other.",
      ],
      parameters: Type.Object({
        pr_name: Type.String({ description: "Short human title for the PR, e.g. 'Add rate limiter'." }),
        task: Type.String({
          description:
            "Full, self-contained instructions for the PR subagent: what to build, constraints, and how to verify. It will run in an isolated worktree.",
        }),
        mode: Type.Optional(
          StringEnum(["independent", "stack", "graphite"] as const, {
            description:
              "independent = branch off base; stack = manual PR stacked on stack_on; graphite = Graphite stack via gt.",
          }),
        ),
        base: Type.Optional(
          Type.String({ description: "Base branch to branch from (defaults to repo default branch)." }),
        ),
        stack_on: Type.Optional(
          Type.String({
            description:
              "For mode stack/graphite: the PR id/branch to stack on. Defaults to the most recently dispatched PR.",
          }),
        ),
        branch: Type.Optional(Type.String({ description: "Explicit branch name (otherwise derived from pr_name)." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const cwd = ctx.cwd;
        if (!insideTmux()) {
          return {
            content: [
              {
                type: "text",
                text: "Not inside tmux. Start the main agent inside a tmux session so PR subagents can open in side panes (e.g. `tmux new -s pr` then `pi`).",
              },
            ],
            isError: true,
          };
        }

        const mode = (params.mode ?? "independent") as PrEntry["mode"];
        const root = repoRoot(cwd);
        const entries = loadRegistry(cwd);

        // Resolve base branch.
        let base = params.base ?? defaultBranch(cwd);
        if ((mode === "stack" || mode === "graphite") && !params.base) {
          const stackRef = params.stack_on
            ? findEntry(entries, params.stack_on)
            : [...entries].reverse().find((e) => e.depth === 1);
          if (stackRef) base = stackRef.branch;
        }

        const branch = uniqueBranch(cwd, params.branch ?? `pi/pr-${slugify(params.pr_name)}`);
        const wtDir = worktreesDir(cwd);
        fs.mkdirSync(wtDir, { recursive: true });
        const worktree = path.join(wtDir, slugify(branch));

        try {
          git(["worktree", "add", "-b", branch, worktree, base], root);
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to create worktree: ${(err as Error).message}` }],
            isError: true,
          };
        }

        const id = randomUUID().slice(0, 8);
        const entry: PrEntry = {
          id,
          prName: params.pr_name,
          branch,
          base,
          mode,
          paneId: "",
          worktree,
          depth: 1,
          parentId: "root",
          status: "working",
          createdAt: new Date().toISOString(),
        };

        const taskMsg = [
          `You are the dedicated subagent for ONE pull request.`,
          ``,
          `PR title: ${params.pr_name}`,
          `Branch: ${branch} (already checked out here)`,
          `Base branch: ${base}`,
          `Stacking mode: ${mode}`,
          ``,
          `Task:`,
          params.task,
          ``,
          `Follow the pr-worker skill. Make an atomic commit after every coherent change. When you open the PR, call set_pr_number so this pane gets labelled.`,
        ].join("\n");

        const command = buildWorkerCommand(entry, taskMsg);
        let paneId: string;
        try {
          paneId = openPane(worktree, command, paneTitle(entry));
        } catch (err) {
          tryGit(["worktree", "remove", "--force", worktree], root);
          tryGit(["branch", "-D", branch], root);
          return {
            content: [{ type: "text", text: `Failed to open tmux pane: ${(err as Error).message}` }],
            isError: true,
          };
        }
        entry.paneId = paneId;
        saveRegistry(cwd, [...entries, entry]);

        return {
          content: [
            {
              type: "text",
              text: [
                `Dispatched PR subagent.`,
                `  id:       ${id}`,
                `  pr_name:  ${params.pr_name}`,
                `  branch:   ${branch}`,
                `  base:     ${base}`,
                `  mode:     ${mode}`,
                `  worktree: ${worktree}`,
                `  pane:     ${paneId}`,
                ``,
                `Use focus_pr_agent({id:"${id}"}) to jump to it, send_to_pr_agent to steer it, list_pr_agents to track status.`,
              ].join("\n"),
            },
          ],
          details: { id, branch, base, mode, paneId, worktree },
        };
      },
    });

    pi.registerTool({
      name: "list_pr_agents",
      label: "List PR agents",
      description: "List every dispatched PR subagent with its PR number/name, branch, mode, tmux pane and live status.",
      promptGuidelines: ["Use list_pr_agents to review the current set of in-flight PRs before dispatching more."],
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const entries = loadRegistry(ctx.cwd);
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No PR agents dispatched yet." }] };
        }
        const rows = entries.map((e) => {
          const alive = paneAlive(e.paneId) ? "live" : "ended";
          const pr = e.prNumber !== undefined ? `#${e.prNumber}` : "(no PR yet)";
          return `${e.id}  ${pr}  ${e.prName}\n      branch=${e.branch} base=${e.base} mode=${e.mode} pane=${e.paneId} status=${e.status}/${alive}`;
        });
        return { content: [{ type: "text", text: rows.join("\n") }], details: { entries } };
      },
    });

    pi.registerTool({
      name: "focus_pr_agent",
      label: "Focus PR agent",
      description: "Move the tmux focus to a PR subagent's pane so you can watch or talk to it.",
      parameters: Type.Object({
        id: Type.String({ description: "PR id, branch, name, or #number." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const entry = findEntry(loadRegistry(ctx.cwd), params.id);
        if (!entry) return { content: [{ type: "text", text: `No PR agent matching '${params.id}'.` }], isError: true };
        tryTmux(["select-window", "-t", entry.paneId]);
        const ok = tryTmux(["select-pane", "-t", entry.paneId]);
        return {
          content: [{ type: "text", text: ok === null ? "Pane no longer exists." : `Focused ${entry.prName} (${entry.paneId}).` }],
        };
      },
    });

    pi.registerTool({
      name: "send_to_pr_agent",
      label: "Send to PR agent",
      description: "Type a message into a PR subagent's pi session and submit it (steer it, answer a question, or give follow-up work).",
      promptGuidelines: ["Use send_to_pr_agent to give a running PR subagent follow-up instructions instead of editing code yourself."],
      parameters: Type.Object({
        id: Type.String({ description: "PR id, branch, name, or #number." }),
        message: Type.String({ description: "Message to send to the subagent." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const entry = findEntry(loadRegistry(ctx.cwd), params.id);
        if (!entry) return { content: [{ type: "text", text: `No PR agent matching '${params.id}'.` }], isError: true };
        if (!paneAlive(entry.paneId)) {
          return { content: [{ type: "text", text: `Pane ${entry.paneId} is no longer live.` }], isError: true };
        }
        tryTmux(["send-keys", "-t", entry.paneId, "-l", "--", params.message]);
        tryTmux(["send-keys", "-t", entry.paneId, "Enter"]);
        return { content: [{ type: "text", text: `Sent to ${entry.prName} (${entry.paneId}).` }] };
      },
    });

    pi.registerTool({
      name: "cleanup_pr_worktrees",
      label: "Cleanup PR worktrees",
      description:
        "Remove worktrees, branches and panes for PRs that are now merged or closed, plus prune orphaned worktrees. Pass dry_run to preview.",
      parameters: Type.Object({ dry_run: Type.Optional(Type.Boolean()) }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const res = runCleanup(ctx.cwd, params.dry_run ?? false);
        const body = res.lines.length ? res.lines.join("\n") : "Nothing to clean up.";
        const tail = res.kept.length ? `\n\nStill active:\n  ${res.kept.join("\n  ")}` : "";
        return { content: [{ type: "text", text: body + tail }], details: res };
      },
    });

    pi.registerCommand("cleanup", {
      description: "Clean up worktrees/branches/panes for merged or closed PRs",
      handler: async (args, ctx) => {
        const dry = /\bdry\b|--dry/.test(args ?? "");
        const res = runCleanup(ctx.cwd, dry);
        const msg = res.lines.length ? res.lines.join("\n") : "Nothing to clean up.";
        ctx.ui.notify(dry ? `[dry run]\n${msg}` : msg, "info");
      },
    });

    pi.registerCommand("pr-agents", {
      description: "List dispatched PR subagents",
      handler: async (_args, ctx) => {
        const entries = loadRegistry(ctx.cwd);
        if (entries.length === 0) {
          ctx.ui.notify("No PR agents dispatched yet.", "info");
          return;
        }
        const text = entries
          .map((e) => {
            const pr = e.prNumber !== undefined ? `#${e.prNumber}` : "(pending)";
            const alive = paneAlive(e.paneId) ? "live" : "ended";
            return `${e.id} ${pr} ${e.prName} — ${e.branch} [${e.mode}/${e.status}/${alive}]`;
          })
          .join("\n");
        ctx.ui.notify(text, "info");
      },
    });
  }

  // =====================================================================
  // DEPTH 1 — a PR subagent: can register its PR + spawn helpers
  // =====================================================================
  if (level === 1) {
    pi.registerTool({
      name: "set_pr_number",
      label: "Set PR number",
      description:
        "Record the PR number (and url) you just opened so the main agent and this tmux pane are labelled correctly. Call this right after creating the pull request.",
      promptGuidelines: ["Use set_pr_number immediately after opening the pull request."],
      parameters: Type.Object({
        number: Type.Integer({ description: "The pull request number." }),
        url: Type.Optional(Type.String({ description: "The pull request URL." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const myId = process.env.PI_PR_ID;
        if (!myId) return { content: [{ type: "text", text: "PI_PR_ID not set; cannot record PR number." }], isError: true };
        const entry = updateEntry(ctx.cwd, myId, {
          prNumber: params.number,
          prUrl: params.url,
          status: "open",
        });
        if (entry && insideTmux() && entry.paneId) setPaneTitle(entry.paneId, paneTitle(entry));
        return { content: [{ type: "text", text: `Recorded PR #${params.number}.` }] };
      },
    });

    pi.registerTool({
      name: "dispatch_helper",
      label: "Dispatch helper subagent",
      description:
        "Spawn a helper subagent in THIS same worktree (e.g. to explore, draft, or review part of the PR) as a new tmux pane. Helpers cannot dispatch further subagents (max depth reached).",
      promptSnippet: "Spawn a helper subagent in this worktree for a focused sub-task.",
      promptGuidelines: ["Use dispatch_helper only for sub-tasks of the current PR; helpers cannot spawn their own subagents."],
      parameters: Type.Object({
        name: Type.String({ description: "Short name for the helper, e.g. 'review' or 'explore-auth'." }),
        task: Type.String({ description: "Self-contained instructions for the helper." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!insideTmux()) {
          return { content: [{ type: "text", text: "Not inside tmux; cannot open a helper pane." }], isError: true };
        }
        const parentId = process.env.PI_PR_ID ?? "root";
        const command = buildHelperCommand(parentId, params.name, params.task);
        let paneId: string;
        try {
          paneId = openPane(ctx.cwd, command, `↳ helper: ${params.name}`);
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to open helper pane: ${(err as Error).message}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Spawned helper '${params.name}' in pane ${paneId}. It works in this worktree and cannot spawn further agents.` }] };
      },
    });
  }

  // Depth >= 2 (helpers): no dispatch tools are registered — they just work.
  void os;
}
