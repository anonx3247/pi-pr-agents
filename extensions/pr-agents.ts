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
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const WORKER_PROMPT = path.join(PKG_ROOT, "assets", "worker-system.md");
const HELPER_PROMPT = path.join(PKG_ROOT, "assets", "helper-system.md");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function depth(): number {
  const n = Number.parseInt(process.env.PI_PR_DEPTH ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function insideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function slugify(s: string): string {
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

/**
 * Run `gh` in `cwd` and return parsed JSON (when the args request `--json`),
 * the trimmed stdout otherwise, or `null` on any failure (missing gh,
 * unauthenticated, non-zero exit, or JSON parse error). Never throws, so the
 * GitHub poller degrades to a silent no-op when gh is unavailable.
 */
function runGh(args: string[], cwd: string): unknown {
  let out: string;
  try {
    out = execFileSync("gh", args, { cwd, stdio: "pipe", timeout: 15000 }).toString().trim();
  } catch {
    return null;
  }
  if (!args.includes("--json")) return out;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Run a `gh api` call (or any gh command whose stdout is raw JSON) and return
 * the parsed value, or `null` on any failure. Unlike {@link runGh}, this parses
 * even when `--json` is absent (gh api emits JSON without that flag).
 */
function runGhApiJson(args: string[], cwd: string): unknown {
  const out = runGh(args, cwd);
  if (typeof out !== "string") return null;
  try {
    return JSON.parse(out);
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

/** True when the Graphite CLI (`gt`) is installed and runnable. */
export function graphiteAvailable(): boolean {
  try {
    execFileSync("gt", ["--version"], { stdio: "pipe", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function gitCommonDir(cwd: string): string {
  const d = git(["rev-parse", "--git-common-dir"], cwd);
  return path.resolve(cwd, d);
}

export function defaultBranch(cwd: string): string {
  const head = tryGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (head) return head.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (tryGit(["rev-parse", "--verify", b], cwd)) return b;
  }
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

// ---------------------------------------------------------------------------
// Persistent per-user state (e.g. "already offered the tmux alias")
// ---------------------------------------------------------------------------

interface UserState {
  aliasPrompted?: boolean;
  aliasInstalledAt?: string;
}

function statePath(): string {
  const dir = path.join(os.homedir(), ".pi", "pr-agents");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return path.join(dir, "state.json");
}

function loadState(): UserState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8")) as UserState;
  } catch {
    return {};
  }
}

function saveState(patch: Partial<UserState>): void {
  const next = { ...loadState(), ...patch };
  try {
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Per-PROJECT config (e.g. the default stacking strategy for this repo)
//
// Unlike the per-user state above (~/.pi/pr-agents/state.json), this lives in
// the repo at <repo-root>/.pi/pr-agents.json so the choice travels with the
// project. It records ONLY the default strategy used when the orchestrator
// stacks DEPENDENT PRs: "github" → dispatch_pr mode "stack", "graphite" →
// mode "graphite". Standalone PRs stay "independent", and an explicit `mode`
// passed to dispatch_pr always wins. We never touch .gitignore — whether to
// commit .pi/pr-agents.json is left to the user.
// ---------------------------------------------------------------------------

export type StackStrategy = "github" | "graphite";

export interface ProjectConfig {
  strategy?: StackStrategy;
}

export function projectConfigPath(cwd: string): string {
  const dir = path.join(repoRoot(cwd), ".pi");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "pr-agents.json");
}

export function loadProjectConfig(cwd: string): ProjectConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as ProjectConfig) : {};
  } catch {
    return {};
  }
}

export function saveProjectConfig(cwd: string, patch: Partial<ProjectConfig>): void {
  const next = { ...loadProjectConfig(cwd), ...patch };
  try {
    fs.writeFileSync(projectConfigPath(cwd), JSON.stringify(next, null, 2));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// tmux wrapper alias installer
//
// Installs a shell `pi` function so that running `pi` outside tmux launches it
// inside a tmux session (creating/attaching one named after the cwd). Inside
// tmux it just runs the real pi. This makes the PR-pane workflow the default.
// ---------------------------------------------------------------------------

const ALIAS_BEGIN = "# >>> pi-pr-agents tmux wrapper >>>";
const ALIAS_END = "# <<< pi-pr-agents tmux wrapper <<<";

export type ShellKind = "zsh" | "bash" | "fish" | "unknown";

export function detectShell(): ShellKind {
  const s = (process.env.SHELL ?? "").toLowerCase();
  if (s.includes("zsh")) return "zsh";
  if (s.includes("bash")) return "bash";
  if (s.includes("fish")) return "fish";
  return "unknown";
}

function shellRcPath(kind: ShellKind): string | undefined {
  const home = os.homedir();
  switch (kind) {
    case "zsh":
      return path.join(home, ".zshrc");
    case "bash":
      return fs.existsSync(path.join(home, ".bashrc")) ? path.join(home, ".bashrc") : path.join(home, ".bash_profile");
    case "fish":
      return path.join(home, ".config", "fish", "functions", "pr-pi.fish");
    default:
      return undefined;
  }
}

export function aliasBlock(kind: ShellKind): string {
  if (kind === "fish") {
    return [
      ALIAS_BEGIN,
      "function pr-pi --wraps pi --description 'Run pi inside tmux (pi-pr-agents)'",
      "    if set -q TMUX",
      "        command pi $argv",
      "    else",
      "        set -l _sess 'pi-'(basename $PWD | tr -c 'A-Za-z0-9_-' '_')",
      "        command tmux new-session -A -s $_sess (command -v pi) $argv",
      "    end",
      "end",
      ALIAS_END,
      "",
    ].join("\n");
  }
  // bash / zsh
  return [
    ALIAS_BEGIN,
    "pr-pi() {",
    '  if [ -n "$TMUX" ]; then',
    '    command pi "$@"',
    "  else",
    "    local _pi _sess",
    '    _pi="$(command -v pi)"',
    `    _sess="pi-$(basename "$PWD" | tr -c 'A-Za-z0-9_-' '_')"`,
    '    command tmux new-session -A -s "$_sess" "$_pi" "$@"',
    "  fi",
    "}",
    ALIAS_END,
    "",
  ].join("\n");
}

function aliasInstalled(rc: string): boolean {
  try {
    return fs.readFileSync(rc, "utf8").includes(ALIAS_BEGIN);
  } catch {
    return false;
  }
}

interface InstallResult {
  ok: boolean;
  rc?: string;
  shell: ShellKind;
  message: string;
}

function installTmuxAlias(): InstallResult {
  const shell = detectShell();
  const rc = shellRcPath(shell);
  if (!rc) {
    return {
      ok: false,
      shell,
      message:
        "Could not detect a supported shell (zsh/bash/fish). Add a `pr-pi` wrapper manually that runs `tmux new-session -A -s pi pi`.",
    };
  }
  try {
    if (aliasInstalled(rc)) {
      return { ok: true, rc, shell, message: `Already installed in ${rc}.` };
    }
    fs.mkdirSync(path.dirname(rc), { recursive: true });
    const block = aliasBlock(shell);
    if (shell === "fish") {
      fs.writeFileSync(rc, block); // standalone function file
    } else {
      const prefix = fs.existsSync(rc) ? "\n" : "";
      fs.appendFileSync(rc, prefix + block);
    }
    saveState({ aliasInstalledAt: new Date().toISOString() });
    return {
      ok: true,
      rc,
      shell,
      message: `Installed pr-pi tmux wrapper in ${rc}. Restart your shell or run: source ${rc}`,
    };
  } catch (err) {
    return { ok: false, rc, shell, message: `Failed to write ${rc}: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Registry (shared across worktrees)
// ---------------------------------------------------------------------------

export interface PrEntry {
  id: string;
  prName: string;
  branch: string;
  base: string;
  mode: "independent" | "stack" | "graphite" | "helper";
  paneId: string;
  worktree: string;
  depth: number;
  parentId: string;
  simplify?: boolean;
  prNumber?: number;
  prUrl?: string;
  status: "working" | "open" | "merged" | "closed" | "stopped";
  createdAt: string;
  // Set by the worker (depth 1) via `pr_pushed` once the branch is pushed AND
  // the PR exists. Only then does the orchestrator start polling this entry's
  // GitHub state — before that the PR may not exist yet, so we make zero gh calls.
  pushed?: boolean;
  pushedAt?: string;
  // Set by a PR subagent (depth 1) every time it finishes a turn, so the
  // orchestrator (depth 0) can auto-notify itself of the result. The bridge
  // between the two processes is purely this shared registry file.
  lastResult?: string;
  lastResultAt?: string;
  resultSeq?: number;
  // Set by a PR subagent (depth 1) review poller + CI poller + reply tool: the
  // set of ids already surfaced/handled, keyed distinctly (rc:<id> inline
  // comments, rv:<...> review summaries, ic:<...> issue comments, and
  // ci:<headSha>:<name> CI failures). Persisted as a UNION so a restart never
  // reprocesses old comments, a CI failure is surfaced once per commit, and the
  // bot's own replies (recorded here immediately) are never re-surfaced as new.
  seenReviewIds?: string[];
}

export function registryPath(cwd: string): string {
  const dir = path.join(gitCommonDir(cwd), "pi-pr-agents");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "registry.json");
}

export function loadRegistry(cwd: string): PrEntry[] {
  try {
    const raw = fs.readFileSync(registryPath(cwd), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRegistry(cwd: string, entries: PrEntry[]): void {
  fs.writeFileSync(registryPath(cwd), JSON.stringify(entries, null, 2));
}

export function updateEntry(cwd: string, id: string, patch: Partial<PrEntry>): PrEntry | undefined {
  const entries = loadRegistry(cwd);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return undefined;
  entries[idx] = { ...entries[idx], ...patch };
  saveRegistry(cwd, entries);
  return entries[idx];
}

export function findEntry(entries: PrEntry[], ref: string): PrEntry | undefined {
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
// simplify_diff (pure helpers)
//
// These reproduce pi-simplify's behavior without bouncing through its
// /simplify slash command (which would deadlock an autonomous worker that
// stays in-turn). They mirror pi-simplify's git-diff.ts (parseDiffOutput) and
// prompt-builder.ts (buildSimplifyPrompt) so the worker can simplify inline.
// ---------------------------------------------------------------------------

export type ChangedFileStatus = "modified" | "added" | "renamed" | "copied";

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
}

const SIMPLIFY_STATUS_MAP: Record<string, ChangedFileStatus> = {
  M: "modified",
  A: "added",
  R: "renamed",
  C: "copied",
};

/**
 * Parse `git diff --name-status` output into {path, status}[].
 * Mirrors pi-simplify's parseDiffOutput: renamed (R100\told\tnew) and copied
 * (C100\told\tnew) lines carry two paths — use the NEW path (3rd tab field).
 */
export function parseChangedFiles(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const statusCode = parts[0]?.[0];
    if (!statusCode) continue;
    const status = SIMPLIFY_STATUS_MAP[statusCode];
    if (!status) continue;
    const path = status === "renamed" || status === "copied" ? parts[2] : parts[1];
    if (path) files.push({ path, status });
  }
  return files;
}

/**
 * Build the simplification prompt. Reproduces pi-simplify's prompt-builder.ts
 * template verbatim (Principles / Scope / Process), then appends a worker-flow
 * instruction so the worker applies the changes INLINE in the same turn and
 * commits them, rather than waiting for any separate command.
 */
export function buildSimplifyPrompt(files: readonly ChangedFile[]): string {
  const fileList = files.map((f) => `- ${f.path} (${f.status})`).join("\n");
  return `Review the following recently changed files and apply simplification improvements.

## Principles

- **Preserve functionality**: Never change what the code does. All existing tests must continue to pass.
- **Apply project standards**: Follow any conventions from CLAUDE.md or AGENTS.md in this project.
- **Enhance clarity**: Reduce unnecessary complexity and nesting, eliminate redundant code and abstractions, improve variable and function names, consolidate related logic, remove unnecessary comments that describe obvious code. Avoid nested ternary operators: prefer switch statements or if/else chains for multiple conditions.
- **Maintain balance**: Do not over-simplify. Avoid overly clever solutions that are hard to understand. Do not combine too many concerns into single functions. Do not remove helpful abstractions. Prioritize readability over fewer lines.

## Scope

Only review and modify these files:
${fileList}

## Process

1. Read each file listed above
2. Identify concrete improvements (dead code, unclear names, redundant logic, inconsistent patterns)
3. Apply changes one file at a time
4. After all changes, run existing tests to verify nothing is broken
5. Summarize what you changed and why

Do NOT add new features, change public APIs, or refactor code outside the listed files.

After applying these simplifications and verifying tests pass, commit the result as a single atomic \`refactor: simplify\` commit, then continue to push and open/update the PR. Do not wait for any separate command — apply the changes now, in this turn.`;
}

// ---------------------------------------------------------------------------
// agent_end → orchestrator notification (pure helpers)
//
// When a PR subagent (depth 1) finishes a turn, it records its final result on
// its own registry entry; the orchestrator (depth 0) polls the registry and
// notifies itself. These helpers are pure so they can be unit-tested without a
// live pi session.
// ---------------------------------------------------------------------------

/** Default cap (in chars) for a captured subagent result. */
export const MAX_RESULT_CHARS = 2000;

/** A minimal view of an assistant text content part. */
interface TextPartLike {
  type?: string;
  text?: string;
}

/** A minimal view of a message from `agent_end` event.messages. */
interface MessageLike {
  role?: string;
  content?: unknown;
}

/**
 * Cap a string to `cap` chars, keeping the TAIL (a subagent's final summary is
 * usually at the end). When truncated, a leading ellipsis marks the cut so the
 * result stays exactly `cap` chars.
 */
export function capTail(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `…${s.slice(s.length - cap + 1)}`;
}

/**
 * Extract a subagent's final result from the messages of a finished prompt:
 * take the LAST assistant message, concatenate its text parts, trim, and cap to
 * the tail. Returns "" when there is no meaningful assistant text.
 */
export function extractFinalResult(messages: readonly MessageLike[], cap = MAX_RESULT_CHARS): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const content = m.content;
    let text: string;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((p): p is TextPartLike => Boolean(p) && typeof p === "object" && (p as TextPartLike).type === "text")
        .map((p) => p.text ?? "")
        .join("");
    } else {
      return "";
    }
    const trimmed = text.trim();
    return trimmed.length === 0 ? "" : capTail(trimmed, cap);
  }
  return "";
}

/**
 * Find every PR subagent (depth 1) whose `resultSeq` is newer than the last-seen
 * value. The seq + last-seen map dedups across polling ticks so each genuine
 * completion notifies exactly once.
 */
export function selectNewlyFinished(
  entries: readonly PrEntry[],
  lastSeen: ReadonlyMap<string, number>,
): { entry: PrEntry; seq: number }[] {
  const out: { entry: PrEntry; seq: number }[] = [];
  for (const e of entries) {
    if (e.depth !== 1 || typeof e.resultSeq !== "number") continue;
    if (e.resultSeq > (lastSeen.get(e.id) ?? -1)) out.push({ entry: e, seq: e.resultSeq });
  }
  return out;
}

/**
 * Build the orchestrator notification for one or more newly-finished PR
 * subagents. Multiple agents are combined into ONE message to reduce noise.
 */
export function buildFinishedNotification(entries: readonly PrEntry[]): string {
  const blocks = entries.map((e) => {
    const pr = e.prNumber !== undefined ? `#${e.prNumber}` : "pending";
    return [
      `- id ${e.id} · PR ${pr} · ${e.prName} · ${e.branch}`,
      `  result: ${e.lastResult ?? "(no result captured)"}`,
    ].join("\n");
  });
  const header =
    entries.length === 1 ? "A PR subagent stopped working:" : `${entries.length} PR subagents stopped working:`;
  return [
    header,
    "",
    ...blocks,
    "",
    "A PR subagent stopped working. Review its result and decide the next step (peek_pr_agent for more, send_to_pr_agent to steer, /cleanup if merged, or do nothing if it's merely waiting on you). Do not take destructive actions without cause.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// GitHub state poller → orchestrator cleanup (pure helpers)
//
// The orchestrator (depth 0) polls `gh pr view` for each live PR subagent. When
// a PR transitions to MERGED or CLOSED on GitHub, it auto-notifies itself to run
// cleanup. Classification and transition selection are kept pure (no gh/exec) so
// they can be unit-tested without a live session or network.
// ---------------------------------------------------------------------------

/** A PR's GitHub lifecycle state, as classified from `gh pr view --json`. */
export type PrStateClass = "merged" | "closed" | "open" | "unknown";

/**
 * True when the orchestrator should poll this entry's GitHub state: it must be a
 * PR subagent (depth 1) that has signalled `pr_pushed` (so the PR actually
 * exists), carry a numeric PR number, and not already be in a terminal state.
 * Before a worker calls `pr_pushed`, this is false so we make ZERO gh calls.
 */
export function isPollable(entry: PrEntry): boolean {
  return (
    entry.depth === 1 &&
    entry.pushed === true &&
    typeof entry.prNumber === "number" &&
    entry.status !== "merged" &&
    entry.status !== "closed" &&
    entry.status !== "stopped"
  );
}

/**
 * Classify the JSON returned by `gh pr view --json state,mergedAt,closedAt,...`
 * into a lifecycle state. A non-null `mergedAt` always means merged; otherwise
 * the textual `state` (gh emits "MERGED"/"CLOSED"/"OPEN") decides. Anything
 * unrecognized (including null/non-object input) is "unknown".
 */
export function classifyPrState(json: unknown): PrStateClass {
  if (!json || typeof json !== "object") return "unknown";
  const j = json as { state?: unknown; mergedAt?: unknown };
  if (j.mergedAt != null) return "merged";
  const state = typeof j.state === "string" ? j.state.toUpperCase() : "";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (state === "OPEN") return "open";
  return "unknown";
}

/**
 * From a list of freshly-classified PR entries, select those whose state has
 * transitioned to a TERMINAL state (merged/closed) that differs from the
 * last-known state. The last-seen map dedups across polling ticks so each
 * genuine transition notifies exactly once.
 */
export function selectStateTransitions(
  classified: ReadonlyArray<{ entry: PrEntry; state: PrStateClass }>,
  lastState: ReadonlyMap<string, string>,
): { entry: PrEntry; state: "merged" | "closed" }[] {
  const out: { entry: PrEntry; state: "merged" | "closed" }[] = [];
  for (const { entry, state } of classified) {
    if (state !== "merged" && state !== "closed") continue;
    if (lastState.get(entry.id) === state) continue;
    out.push({ entry, state });
  }
  return out;
}

/**
 * Build the orchestrator notification for one or more PRs that just reached a
 * terminal state on GitHub. Multiple transitions in one tick are combined into a
 * single message to reduce noise.
 */
export function buildCleanupNotification(
  transitions: ReadonlyArray<{ entry: PrEntry; state: "merged" | "closed" }>,
): string {
  const lines = transitions.map(({ entry, state }) => {
    const pr = entry.prNumber !== undefined ? `#${entry.prNumber}` : "(no number)";
    return `PR ${pr} '${entry.prName}' (branch ${entry.branch}) was ${state} on GitHub.`;
  });
  return [
    ...lines,
    "",
    "Run cleanup now: call cleanup_pr_worktrees to remove its worktree, branch, and tmux window.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Review-comment loop (pure helpers + types)
//
// A PR subagent (depth 1) polls its OWN PR for new reviewer feedback and, when
// new inline comments arrive, injects a task into a fresh turn to address them,
// push, and reply (without resolving threads). The selection of what is NEW and
// the task message are kept pure (no gh/exec/IO) so they can be unit-tested.
// ---------------------------------------------------------------------------

/** Poll interval (ms) for a subagent checking its own PR for review activity. */
export const REVIEW_POLL_MS = 30000;

/** An actionable inline review comment (a file/line comment on the PR diff). */
export interface InlineComment {
  id: number;
  user: string;
  body: string;
  path: string;
  line: number | null;
  createdAt: string;
  inReplyToId: number | null;
}

/** A review summary (gh pr view --json reviews) — surfaced as context. */
export interface ReviewSummary {
  id?: number;
  author: string;
  body: string;
  state: string;
  submittedAt: string;
}

/** A general PR (issue) comment (gh pr view --json comments) — surfaced as context. */
export interface IssueComment {
  id?: number;
  author: string;
  body: string;
  createdAt: string;
}

/** Everything the poller fetches for one PR in a single tick. */
export interface FetchedReviewActivity {
  inline: InlineComment[];
  reviews: ReviewSummary[];
  issueComments: IssueComment[];
}

/** Result of {@link selectNewReviewItems}: the actionable + context split. */
export interface NewReviewSelection {
  actionable: InlineComment[];
  contextNotes: string[];
  newIds: string[];
}

/**
 * Select the NEW review items from a fetched tick against the seen-set. Ids are
 * keyed distinctly so the three kinds never collide: inline comments `rc:<id>`,
 * review summaries `rv:<id|submittedAt+author>`, issue comments
 * `ic:<id|createdAt+author>`. Inline comments are the actionable items; non-empty
 * review/issue bodies become context notes. `newIds` carries EVERY surfaced key
 * (actionable + context) so the caller can mark them all seen and never
 * re-surface them — including the subagent's OWN replies, which the reply tool
 * records into seen immediately. Pure: no IO.
 */
export function selectNewReviewItems(fetched: FetchedReviewActivity, seen: ReadonlySet<string>): NewReviewSelection {
  const actionable: InlineComment[] = [];
  const contextNotes: string[] = [];
  const newIds: string[] = [];

  for (const c of fetched.inline) {
    const key = `rc:${c.id}`;
    if (seen.has(key) || newIds.includes(key)) continue;
    actionable.push(c);
    newIds.push(key);
  }

  for (const r of fetched.reviews) {
    const body = (r.body ?? "").trim();
    if (!body) continue;
    const state = (r.state ?? "").toUpperCase();
    if (state !== "COMMENTED" && state !== "CHANGES_REQUESTED") continue;
    const key = `rv:${r.id ?? `${r.submittedAt}+${r.author}`}`;
    if (seen.has(key) || newIds.includes(key)) continue;
    contextNotes.push(`review by ${r.author || "?"} (${state}): ${body}`);
    newIds.push(key);
  }

  for (const c of fetched.issueComments) {
    const body = (c.body ?? "").trim();
    if (!body) continue;
    const key = `ic:${c.id ?? `${c.createdAt}+${c.author}`}`;
    if (seen.has(key) || newIds.includes(key)) continue;
    contextNotes.push(`comment by ${c.author || "?"}: ${body}`);
    newIds.push(key);
  }

  return { actionable, contextNotes, newIds };
}

/**
 * Build the task message handed to the subagent when new inline review comments
 * arrive. Lists each comment as `- [rc:<id>] <path>:<line> — <body>` plus any
 * context notes, then the fixed instructions: address with code, run the gate,
 * commit, push, and REPLY to each thread via `reply_to_review_comment` WITHOUT
 * resolving threads. Pure: no IO.
 */
export function buildReviewTask(
  actionable: readonly InlineComment[],
  contextNotes: readonly string[],
  prNumber: number,
): string {
  const lines: string[] = [
    `New review feedback on PR #${prNumber}. Address each reviewer comment below.`,
    "",
    "Inline review comments:",
  ];
  for (const c of actionable) {
    const loc = c.line != null ? `${c.path}:${c.line}` : c.path;
    lines.push(`- [rc:${c.id}] ${loc} — ${c.body}`);
  }
  if (contextNotes.length > 0) {
    lines.push("", "Additional context:");
    for (const n of contextNotes) lines.push(`- ${n}`);
  }
  lines.push(
    "",
    [
      "Address each comment with code changes; run `npm run typecheck && npm run lint && npm test`;",
      "commit (e.g. `fix: address review feedback`); push with `git push`; then REPLY to EACH inline",
      "thread using the `reply_to_review_comment` tool (commentId = the numeric id from `rc:<id>`,",
      "body = a short explanation of the fix or a clarifying question). Do NOT resolve threads — leave",
      "that to the reviewer. If a comment is ambiguous or architectural, reply asking for clarification",
      "instead of guessing.",
    ].join(" "),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CI-failure loop (depth 1, subagent-owned)
// ---------------------------------------------------------------------------
// Folded into the SAME poll tick as the review loop: once THIS PR is pushed, the
// subagent also reads its CI check status and, when checks FAIL, injects a task
// to reproduce the failure locally (with the same gate CI runs), fix it, commit,
// and push. Failures are deduped ONCE PER COMMIT via `ci:<headSha>:<name>` keys
// (stored in the same seen-set as review ids), so a still-failing check after a
// fix-push gets a new sha => new key => re-notifies, while a passing run never
// notifies. The selection of NEW failures and the task message are kept pure (no
// gh/exec/IO) so they can be unit-tested.

/** A single CI check on the PR's head commit (gh pr checks --json ...). */
export interface CiCheck {
  name: string;
  /** Raw state, e.g. failure/cancelled/timed_out/action_required/success/pending. */
  state: string;
  /** gh's coarse bucket: one of pass/fail/pending/skipping. */
  bucket: string;
  /** Details URL for the check run. */
  link: string;
}

/** A failing CI check surfaced to the subagent. */
export interface CiFailure {
  name: string;
  state: string;
  link: string;
}

/** Result of {@link selectNewCiFailures}: the failures + their seen-keys. */
export interface NewCiSelection {
  failures: CiFailure[];
  newKeys: string[];
}

/**
 * Select the NEW CI failures for the PR's current head commit against the
 * seen-set. Only `bucket === "fail"` checks count as failures (pending/pass/
 * skipping are ignored). Each failure is keyed `ci:<headSha>:<name>` so it is
 * deduped ONCE PER COMMIT: after a fix-push the head sha changes, so a check
 * that is still failing produces a NEW key and re-surfaces, while a passing run
 * never produces a key. Returns only failures whose key is not already seen.
 * Pure: no IO.
 */
export function selectNewCiFailures(
  checks: readonly CiCheck[],
  headSha: string,
  seen: ReadonlySet<string>,
): NewCiSelection {
  const failures: CiFailure[] = [];
  const newKeys: string[] = [];
  for (const c of checks) {
    if (c.bucket !== "fail") continue;
    const key = `ci:${headSha}:${c.name}`;
    if (seen.has(key) || newKeys.includes(key)) continue;
    failures.push({ name: c.name, state: c.state, link: c.link });
    newKeys.push(key);
  }
  return { failures, newKeys };
}

/**
 * Build the task message handed to the subagent when CI fails. Lists each
 * failing check as `- <name> (<state>) <link>` plus the fixed instructions:
 * reproduce locally with the gate, fix, commit, push, and (if needed) inspect
 * logs — never weaken checks to make CI pass. Pure: no IO.
 */
export function buildCiFixTask(failures: readonly CiFailure[], prNumber: number): string {
  const lines: string[] = [`CI is failing on PR #${prNumber}. The following checks failed:`, ""];
  for (const f of failures) {
    const link = f.link ? ` ${f.link}` : "";
    lines.push(`- ${f.name} (${f.state})${link}`);
  }
  lines.push(
    "",
    [
      "Reproduce locally by running the gate — `npm run typecheck && npm run lint && npm test` — fix the",
      "cause, commit (e.g. `fix: resolve CI failure`), and `git push`. If the failure is",
      "environment-specific or unclear from the gate, inspect logs with `gh run view --log-failed` (find",
      "the run via `gh run list --branch <branch>`). Do not disable or weaken checks to make CI pass.",
    ].join(" "),
  );
  return lines.join("\n");
}

/** Map a statusCheckRollup conclusion/state to gh's coarse bucket. */
function rollupBucket(stateUpper: string): string {
  switch (stateUpper) {
    case "FAILURE":
    case "ERROR":
    case "CANCELLED":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "fail";
    case "SUCCESS":
      return "pass";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipping";
    default:
      return "pending";
  }
}

/**
 * Fetch CI check status for one PR via gh. Reads the head commit sha
 * (`headRefOid`) and the checks (`gh pr checks --json name,state,bucket,link`),
 * falling back to `statusCheckRollup` when `gh pr checks --json` is unavailable.
 * Tolerates nulls/missing fields everywhere; returns `null` when the head sha
 * can't be resolved so the feature degrades to a no-op. IO; not pure.
 */
function fetchCiChecks(prNumber: number, cwd: string): { headSha: string; checks: CiCheck[] } | null {
  const headJson = runGh(["pr", "view", String(prNumber), "--json", "headRefOid"], cwd) as {
    headRefOid?: unknown;
  } | null;
  const headSha = typeof headJson?.headRefOid === "string" ? headJson.headRefOid : "";
  if (!headSha) return null;

  const checks: CiCheck[] = [];
  const raw = runGh(["pr", "checks", String(prNumber), "--json", "name,state,bucket,link"], cwd);
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const name = str(o, "name");
      if (!name) continue;
      checks.push({
        name,
        state: str(o, "state"),
        bucket: str(o, "bucket"),
        link: str(o, "link"),
      });
    }
    return { headSha, checks };
  }

  // Fallback for older gh: map statusCheckRollup conclusions to buckets.
  const roll = runGh(["pr", "view", String(prNumber), "--json", "statusCheckRollup"], cwd) as {
    statusCheckRollup?: unknown;
  } | null;
  if (roll && Array.isArray(roll.statusCheckRollup)) {
    for (const c of roll.statusCheckRollup) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const name = str(o, "name") || str(o, "context");
      if (!name) continue;
      // CheckRun uses `conclusion`; StatusContext uses `state`.
      const rawState = str(o, "conclusion") || str(o, "state");
      const stateUpper = rawState.toUpperCase();
      checks.push({
        name,
        state: rawState.toLowerCase(),
        bucket: rollupBucket(stateUpper),
        link: str(o, "detailsUrl") || str(o, "targetUrl"),
      });
    }
  }
  return { headSha, checks };
}

/**
 * Fetch all review activity for one PR (inline comments + review summaries +
 * issue comments) via gh. Tolerates nulls/missing fields everywhere: any gh
 * failure yields an empty slice so the feature degrades to a no-op. IO; not pure.
 */
/** Safe field accessors over the loosely-typed JSON gh returns. */
function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}
function numOrUndef(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" ? v : undefined;
}
/** Extract a nested `<key>.login` string (gh's author/user objects). */
function loginOf(o: Record<string, unknown>, key: string): string {
  const login = (o[key] as { login?: unknown } | null)?.login;
  return typeof login === "string" ? login : "";
}

function fetchReviewActivity(owner: string, repo: string, prNumber: number, cwd: string): FetchedReviewActivity {
  const inline: InlineComment[] = [];
  const rawInline = runGhApiJson(["api", "--paginate", `repos/${owner}/${repo}/pulls/${prNumber}/comments`], cwd);
  if (Array.isArray(rawInline)) {
    for (const c of rawInline) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const id = Number(o.id);
      if (!Number.isFinite(id)) continue;
      const line = o.line ?? o.original_line ?? null;
      inline.push({
        id,
        user: loginOf(o, "user"),
        body: str(o, "body"),
        path: str(o, "path"),
        line: typeof line === "number" ? line : null,
        createdAt: str(o, "created_at"),
        inReplyToId: numOrUndef(o, "in_reply_to_id") ?? null,
      });
    }
  }

  const reviews: ReviewSummary[] = [];
  const rv = runGh(["pr", "view", String(prNumber), "--json", "reviews"], cwd) as { reviews?: unknown } | null;
  if (rv && Array.isArray(rv.reviews)) {
    for (const r of rv.reviews) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      reviews.push({
        id: numOrUndef(o, "id"),
        author: loginOf(o, "author"),
        body: str(o, "body"),
        state: str(o, "state"),
        submittedAt: str(o, "submittedAt"),
      });
    }
  }

  const issueComments: IssueComment[] = [];
  const ic = runGh(["pr", "view", String(prNumber), "--json", "comments"], cwd) as { comments?: unknown } | null;
  if (ic && Array.isArray(ic.comments)) {
    for (const c of ic.comments) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      issueComments.push({
        id: numOrUndef(o, "id"),
        author: loginOf(o, "author"),
        body: str(o, "body"),
        createdAt: str(o, "createdAt"),
      });
    }
  }

  return { inline, reviews, issueComments };
}

/**
 * Post an inline reply to a review comment thread via gh, passing the body over
 * stdin so it is always treated as a literal string (no shell/quoting issues).
 * Returns the created reply's numeric id, or `null` on any failure. A reply does
 * NOT resolve the thread — exactly the desired behavior.
 */
function postReviewReply(
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
  cwd: string,
): number | null {
  let out: string;
  try {
    out = execFileSync(
      "gh",
      ["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`, "-F", "body=@-"],
      { cwd, input: body, stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
    )
      .toString()
      .trim();
  } catch {
    return null;
  }
  try {
    const id = (JSON.parse(out) as { id?: unknown }).id;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve `owner/name` for the current repo via gh, or `null` if unavailable.
 */
function resolveOwnerRepo(cwd: string): { owner: string; repo: string } | null {
  const j = runGh(["repo", "view", "--json", "nameWithOwner"], cwd) as { nameWithOwner?: unknown } | null;
  const nwo = j?.nameWithOwner;
  if (typeof nwo !== "string" || !nwo.includes("/")) return null;
  const [owner, repo] = nwo.split("/");
  return owner && repo ? { owner, repo } : null;
}

/**
 * Merge `newIds` into an entry's `seenReviewIds` as a UNION (never overwrite),
 * reading the latest registry first so the poller and the reply tool can both
 * add ids without clobbering each other. Best-effort: missing entry => no-op.
 */
function mergeSeenReviewIds(cwd: string, id: string, newIds: readonly string[]): void {
  if (newIds.length === 0) return;
  const entries = loadRegistry(cwd);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const union = new Set(entries[idx].seenReviewIds ?? []);
  for (const x of newIds) union.add(x);
  entries[idx] = { ...entries[idx], seenReviewIds: [...union] };
  saveRegistry(cwd, entries);
}

// ---------------------------------------------------------------------------
// tmux pane management
// ---------------------------------------------------------------------------

function tmuxSetup(): void {
  // Show pane titles so PR panes can be labelled with their PR number/name.
  tryTmux(["set", "-g", "pane-border-status", "top"]);
  tryTmux(["set", "-g", "pane-border-format", " #{pane_title} "]);
  // Enable mouse so the user can click a pane to focus it and type into it.
  tryTmux(["set", "-g", "mouse", "on"]);
}

export function paneTitle(entry: Pick<PrEntry, "prNumber" | "prName" | "branch">): string {
  const tag = entry.prNumber !== undefined ? `PR#${entry.prNumber}` : "PR";
  return `${tag} ${entry.prName} (${entry.branch})`;
}

/**
 * Concise tmux window name (for `tmux list-windows`) derived from the PR
 * number / name / branch. Slugified and capped so the window list stays tidy.
 */
export function windowName(entry: Pick<PrEntry, "prNumber" | "prName" | "branch">): string {
  const tag = entry.prNumber !== undefined ? `pr${entry.prNumber}` : "pr";
  return `${tag}-${slugify(entry.prName || entry.branch)}`.slice(0, 24).replace(/-+$/g, "") || "pr";
}

function paneAlive(paneId: string): boolean {
  const out = tryTmux(["list-panes", "-a", "-F", "#{pane_id}"]);
  if (!out) return false;
  return out.split("\n").includes(paneId);
}

/**
 * Open a new pane running `command` (a shell string) in `cwd`, label it, and
 * re-tile so the dispatching agent stays large on the left (main-vertical).
 * Used for helper subagents, which live alongside their parent PR agent.
 */
function openPane(cwd: string, command: string, title: string): string {
  const paneId = tmux(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, command]);
  tryTmux(["select-pane", "-t", paneId, "-T", title]);
  // Keep the orchestrator pane dominant on the left, PR panes stacked right.
  tryTmux(["set-window-option", "-t", paneId, "main-pane-width", "55%"]);
  tryTmux(["select-layout", "-t", paneId, "main-vertical"]);
  return paneId;
}

/**
 * Launch `command` in its OWN tmux window, created in the background (`-d` keeps
 * focus on the orchestrator). Returns the new pane id (registry's paneId), which
 * still works with `-t %paneId` across windows. Used for PR subagents so the
 * orchestrator stays full-screen; the agent is reachable via the list widget and
 * focus_pr_agent (which select-window + select-pane brings full-screen).
 */
function openWindow(cwd: string, command: string, title: string, name: string): string {
  const paneId = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, "-n", name, command]);
  tryTmux(["select-pane", "-t", paneId, "-T", title]);
  return paneId;
}

function setPaneTitle(paneId: string, title: string): void {
  tryTmux(["select-pane", "-t", paneId, "-T", title]);
}

/** Capture the recent visible output of a pane (for checking in on a subagent). */
function capturePane(paneId: string, lines: number): string | null {
  if (!paneAlive(paneId)) return null;
  const out = tryTmux(["capture-pane", "-p", "-t", paneId, "-S", `-${Math.max(0, lines)}`]);
  if (out === null) return null;
  // Trim trailing blank lines for a tidy snapshot.
  return out.replace(/\n+$/g, "");
}

/**
 * Stop a subagent pane.
 *   - "interrupt": send Escape to abort the current turn (pi app.interrupt) but
 *     keep the session alive so it can be re-steered.
 *   - "kill": kill the pane entirely (worktree/branch are kept for inspection).
 */
function stopPane(paneId: string, mode: "interrupt" | "kill"): boolean {
  if (!paneAlive(paneId)) return false;
  if (mode === "kill") {
    tryTmux(["kill-pane", "-t", paneId]);
    return true;
  }
  tryTmux(["send-keys", "-t", paneId, "Escape"]);
  return true;
}

function sendToPane(paneId: string, message: string): boolean {
  if (!paneAlive(paneId)) return false;
  tryTmux(["send-keys", "-t", paneId, "-l", "--", message]);
  tryTmux(["send-keys", "-t", paneId, "Enter"]);
  return true;
}

// ---------------------------------------------------------------------------
// Dock-right + auto-flip (orchestrator only, inside tmux)
//
// A single PR-agent pane is docked to the RIGHT of the orchestrator's own pane
// (the orchestrator stays dominant on the left via main-vertical). On dispatch
// we auto-flip to the newest agent. Everything is guarded so the orchestrator's
// own pane is NEVER broken or killed.
// ---------------------------------------------------------------------------

// The orchestrator's OWN pane id, captured at depth-0 session_start. Every
// dock/undock targets this pane and must never break/kill it.
let orchestratorPane: string | undefined;
// The PR-agent pane currently joined into the orchestrator window (docked on
// the right), or undefined when the orchestrator pane is alone (collapsed).
let dockedPaneId: string | undefined;

/**
 * Choose which agent to (re)dock: the most-recently-created LIVE depth-1 PR
 * agent. Pure (liveness via the injected predicate) so it can be unit-tested.
 * Returns the chosen entry, or undefined when there are no live agents.
 */
export function pickRedockAgent(
  entries: readonly PrEntry[],
  isAlive: (paneId: string) => boolean,
): PrEntry | undefined {
  const live = entries.filter((e) => e.depth === 1 && e.paneId && isAlive(e.paneId));
  if (live.length === 0) return undefined;
  return live.reduce((best, e) => (e.createdAt > best.createdAt ? e : best));
}

/** True when a pane id is safe to dock/undock (known, non-empty, not the orchestrator). */
function dockable(paneId: string | undefined): paneId is string {
  return insideTmux() && Boolean(orchestratorPane) && Boolean(paneId) && paneId !== orchestratorPane;
}

/** The registry entry currently shown in a tmux pane, if any. */
function entryByPane(cwd: string, paneId: string): PrEntry | undefined {
  return loadRegistry(cwd).find((e) => e.paneId === paneId);
}

/**
 * Send the currently-docked agent's pane back to its own hidden background
 * window (break-pane -d). Guarded so the orchestrator pane is never broken.
 */
function undockCurrent(cwd: string): void {
  const pane = dockedPaneId;
  if (!dockable(pane)) {
    dockedPaneId = undefined;
    return;
  }
  if (paneAlive(pane)) {
    const entry = entryByPane(cwd, pane);
    const name = entry ? windowName(entry) : "pr";
    tryTmux(["break-pane", "-d", "-s", pane, "-n", name]);
  }
  dockedPaneId = undefined;
}

/**
 * Dock `paneId` to the RIGHT of the orchestrator pane: undock the current one,
 * then join the new agent's pane into the orchestrator window and re-tile so the
 * orchestrator stays dominant on the left (main-vertical, 60% main width). If
 * join-pane fails the agent stays in its hidden window (no harm) and
 * dockedPaneId is unchanged. Guarded so the orchestrator pane is never targeted.
 */
function dockAgent(cwd: string, paneId: string): void {
  if (!dockable(paneId) || paneId === dockedPaneId) return;
  const target = orchestratorPane;
  if (!target) return;
  undockCurrent(cwd);
  // join-pane returns "" on success; tryTmux yields null only on failure.
  if (tryTmux(["join-pane", "-h", "-s", paneId, "-t", target]) === null) return;
  tryTmux(["select-layout", "-t", target, "main-vertical"]);
  tryTmux(["set-window-option", "-t", target, "main-pane-width", "60%"]);
  dockedPaneId = paneId;
  const entry = entryByPane(cwd, paneId);
  if (entry) setPaneTitle(paneId, paneTitle(entry));
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
    PI_PR_SIMPLIFY: entry.simplify ? "1" : "0",
  });
  const flags = [
    // Trust project-local files for this run (dispatched worktree of a repo the
    // user already chose to work in).
    "-a",
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
  const flags = ["-a", "--name", shq(`helper: ${name}`)];
  if (fs.existsSync(HELPER_PROMPT)) {
    flags.push("--append-system-prompt", shq(HELPER_PROMPT));
  }
  return `${env} pi ${shq(task)} ${flags.join(" ")}; exec ${process.env.SHELL || "bash"}`;
}

// ---------------------------------------------------------------------------
// Worktree helpers
// ---------------------------------------------------------------------------

/**
 * Pure helper: given a repo root, return the directory where PR/helper
 * worktrees live. They are nested under `<repo-root>/.worktrees` so that every
 * write stays inside the repo root (allowing the user to sandbox writes to the
 * repo). Kept pure (no git/fs) so it can be unit-tested directly.
 */
export function worktreesDirFrom(root: string): string {
  return path.join(root, ".worktrees");
}

function worktreesDir(cwd: string): string {
  return worktreesDirFrom(repoRoot(cwd));
}

/**
 * Best-effort: make sure `.worktrees/` is ignored in this repo so the nested
 * worktree directory never clutters `git status`. We append to the repo's
 * `<git-common-dir>/info/exclude` (local, uncommitted) rather than `.gitignore`
 * so it works in ANY repo the tool runs in. Idempotent and never throws — a
 * failure here must not block dispatch.
 */
function ensureWorktreesIgnored(root: string): void {
  try {
    const excludePath = path.join(gitCommonDir(root), "info", "exclude");
    let current = "";
    try {
      current = fs.readFileSync(excludePath, "utf8");
    } catch {
      // file may not exist yet; we'll create it below
    }
    const lines = current.split("\n").map((l) => l.trim());
    if (lines.includes(".worktrees/")) return;
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, `${prefix}.worktrees/\n`);
  } catch {
    // ignore: keeping git status clean is best-effort
  }
}

export function uniqueBranch(cwd: string, desired: string): string {
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
  return merged
    .split("\n")
    .map((s) => s.trim())
    .includes(branch);
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
  const removedParents = new Set<string>();
  for (const e of entries) {
    if (e.depth > 1) {
      survivors.push(e); // helpers handled in step 1b
      continue;
    }
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
    removedParents.add(e.id);
    if (!dryRun) {
      if (paneAlive(e.paneId)) tryTmux(["kill-pane", "-t", e.paneId]);
      tryGit(["worktree", "remove", "--force", e.worktree], root);
      tryGit(["branch", "-D", e.branch], root);
    }
  }

  // 1b. Helper entries: drop when their pane is gone or their parent PR is gone.
  for (let i = survivors.length - 1; i >= 0; i--) {
    const e = survivors[i];
    if (e.depth <= 1) continue;
    if (removedParents.has(e.parentId) || !paneAlive(e.paneId)) {
      if (!dryRun && paneAlive(e.paneId)) tryTmux(["kill-pane", "-t", e.paneId]);
      survivors.splice(i, 1);
    }
  }

  // 2. Orphaned worktrees that the registry no longer tracks.
  const wtList = tryGit(["worktree", "list", "--porcelain"], root) ?? "";
  for (const block of wtList.split("\n\n")) {
    const m = block.match(/^worktree (.+)$/m);
    if (!m) continue;
    const wt = m[1];
    if (wt === root) continue;
    // Matches both the OLD sibling layout (`<name>.worktrees/`) and the NEW
    // nested layout (`<root>/.worktrees/`), since both contain `.worktrees/`.
    if (!wt.includes(`.worktrees${path.sep}`) && !wt.includes(".worktrees/")) continue;
    if (survivors.some((s) => s.worktree === wt)) continue;
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
// Pane-control tools (shared by depth-0 PR agents and depth-1 helpers)
// ---------------------------------------------------------------------------

interface ToolTextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  details?: unknown;
}

/**
 * Resolve a registry entry or short-circuit with the standard "not found"
 * error. Keeps the find+guard boilerplate out of every tool body. The error
 * wording ("No <noun> matching '<ref>'.") is preserved verbatim per noun.
 */
function withEntry(
  entry: PrEntry | undefined,
  noun: string,
  ref: string,
  fn: (entry: PrEntry) => ToolTextResult,
): ToolTextResult {
  if (!entry) {
    return { content: [{ type: "text", text: `No ${noun} matching '${ref}'.` }], isError: true };
  }
  return fn(entry);
}

/**
 * Register a tool whose body returns the lightweight {@link ToolTextResult}
 * shape. The agent runtime's `AgentToolResult` requires a `details` field on
 * every result, so this wrapper fills it in (defaulting to `undefined`) — the
 * tool bodies stay focused on their text/error/details payload while the
 * registered tool still satisfies the strict `execute` return type.
 */
function registerTextTool<TParams extends TSchema>(
  pi: ExtensionAPI,
  def: Omit<ToolDefinition<TParams>, "execute"> & {
    execute: (...args: Parameters<ToolDefinition<TParams>["execute"]>) => ToolTextResult | Promise<ToolTextResult>;
  },
): void {
  const { execute, ...rest } = def;
  pi.registerTool({
    ...rest,
    async execute(id, params, signal, onUpdate, ctx) {
      const r = await execute(id, params, signal, onUpdate, ctx);
      return { ...r, details: r.details };
    },
  });
}

interface PaneToolMeta {
  name: string;
  label: string;
  description: string;
  promptGuidelines?: string[];
}

interface PaneControlConfig {
  noun: string;
  idDescription: string;
  resolve: (cwd: string, ref: string) => PrEntry | undefined;
  list: PaneToolMeta & {
    empty: string;
    entries: (cwd: string) => PrEntry[];
    row: (e: PrEntry) => string;
    details?: (entries: PrEntry[]) => unknown;
  };
  peek: PaneToolMeta & {
    linesDescription: string;
    header: (e: PrEntry) => string;
    paneDead: (paneId: string) => string;
    details?: (e: PrEntry) => unknown;
  };
  send: PaneToolMeta & {
    messageDescription: string;
    success: (e: PrEntry) => string;
    paneDead: (paneId: string) => string;
  };
  stop: PaneToolMeta & {
    paneDead: (paneId: string) => string;
    result: (mode: "interrupt" | "kill", e: PrEntry) => string;
  };
}

/**
 * Register the list/peek/send/stop quartet for one kind of subagent. The
 * depth-0 PR tools and depth-1 helper tools differ only in which registry
 * entries they resolve over plus some label/wording strings, all captured in
 * `cfg`, so the runtime behaviour is identical to the hand-written tools.
 */
function registerPaneControlTools(pi: ExtensionAPI, cfg: PaneControlConfig): void {
  registerTextTool(pi, {
    name: cfg.list.name,
    label: cfg.list.label,
    description: cfg.list.description,
    ...(cfg.list.promptGuidelines ? { promptGuidelines: cfg.list.promptGuidelines } : {}),
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const entries = cfg.list.entries(ctx.cwd);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: cfg.list.empty }] };
      }
      return {
        content: [{ type: "text", text: entries.map(cfg.list.row).join("\n") }],
        ...(cfg.list.details ? { details: cfg.list.details(entries) } : {}),
      };
    },
  });

  registerTextTool(pi, {
    name: cfg.peek.name,
    label: cfg.peek.label,
    description: cfg.peek.description,
    ...(cfg.peek.promptGuidelines ? { promptGuidelines: cfg.peek.promptGuidelines } : {}),
    parameters: Type.Object({
      id: Type.String({ description: cfg.idDescription }),
      lines: Type.Optional(Type.Integer({ description: cfg.peek.linesDescription })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return withEntry(cfg.resolve(ctx.cwd, params.id), cfg.noun, params.id, (entry) => {
        const snap = capturePane(entry.paneId, params.lines ?? 60);
        if (snap === null) {
          return { content: [{ type: "text", text: cfg.peek.paneDead(entry.paneId) }], isError: true };
        }
        return {
          content: [{ type: "text", text: `${cfg.peek.header(entry)}\n${snap}` }],
          ...(cfg.peek.details ? { details: cfg.peek.details(entry) } : {}),
        };
      });
    },
  });

  registerTextTool(pi, {
    name: cfg.send.name,
    label: cfg.send.label,
    description: cfg.send.description,
    ...(cfg.send.promptGuidelines ? { promptGuidelines: cfg.send.promptGuidelines } : {}),
    parameters: Type.Object({
      id: Type.String({ description: cfg.idDescription }),
      message: Type.String({ description: cfg.send.messageDescription }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return withEntry(cfg.resolve(ctx.cwd, params.id), cfg.noun, params.id, (entry) => {
        if (!sendToPane(entry.paneId, params.message)) {
          return { content: [{ type: "text", text: cfg.send.paneDead(entry.paneId) }], isError: true };
        }
        return { content: [{ type: "text", text: cfg.send.success(entry) }] };
      });
    },
  });

  registerTextTool(pi, {
    name: cfg.stop.name,
    label: cfg.stop.label,
    description: cfg.stop.description,
    ...(cfg.stop.promptGuidelines ? { promptGuidelines: cfg.stop.promptGuidelines } : {}),
    parameters: Type.Object({
      id: Type.String({ description: cfg.idDescription }),
      mode: Type.Optional(StringEnum(["interrupt", "kill"] as const, { description: "interrupt (default) or kill." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return withEntry(cfg.resolve(ctx.cwd, params.id), cfg.noun, params.id, (entry) => {
        const mode = (params.mode ?? "interrupt") as "interrupt" | "kill";
        if (!stopPane(entry.paneId, mode)) {
          return { content: [{ type: "text", text: cfg.stop.paneDead(entry.paneId) }], isError: true };
        }
        if (mode === "kill") updateEntry(ctx.cwd, entry.id, { status: "stopped" });
        return { content: [{ type: "text", text: cfg.stop.result(mode, entry) }] };
      });
    },
  });
}

// ---------------------------------------------------------------------------
// PR-agents list widget (orchestrator only)
// ---------------------------------------------------------------------------

const WIDGET_KEY = "pr-agents";
// Slow poll interval for the GitHub PR-state poller. gh calls are network-bound,
// so this is much slower than the 2000ms widget refresh tick.
const GH_POLL_MS = 30000;
// Braille spinner glyphs pi cycles through while it is "Working".
const SPINNER_GLYPHS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// How many trailing lines of a pane snapshot to scan for the working spinner.
// pi renders its `⠋ Working… / Esc to interrupt` line ABOVE the input box
// (~8-10 lines from the bottom), so a small tail (e.g. 6) misses it and the
// agent wrongly shows idle. Scan a much wider tail to catch it reliably.
const WORKING_SCAN_LINES = 25;

/**
 * True when a pane's recent output shows pi actively working: the braille
 * spinner, or an activity line ("Working" / "Esc to interrupt"). Scans the last
 * {@link WORKING_SCAN_LINES} lines so the activity line (which sits above the
 * input box) is detected. Pure so it can be unit-tested without tmux.
 */
export function isWorkingSnapshot(snapshot: string | null): boolean {
  if (!snapshot) return false;
  const tail = snapshot.split("\n").slice(-WORKING_SCAN_LINES).join("\n");
  if ([...SPINNER_GLYPHS].some((g) => tail.includes(g))) return true;
  return /esc to interrupt/i.test(tail) || /\bWorking\b/.test(tail);
}

type MarkerColor = "success" | "warning" | "dim" | "error";
interface StatusMarker {
  icon: string;
  color: MarkerColor;
  label: string;
}

/**
 * Derive the status marker (icon + theme color + label) for one PR agent from
 * its registry status plus live pane state. Terminal registry states
 * (merged/closed) win; otherwise liveness and the working spinner decide.
 * Pure so it can be unit-tested.
 */
export function statusMarker(status: PrEntry["status"], alive: boolean, working: boolean): StatusMarker {
  if (status === "merged") return { icon: "✓", color: "success", label: "merged" };
  if (status === "closed") return { icon: "✗", color: "error", label: "closed" };
  if (!alive) return { icon: "■", color: "dim", label: status === "stopped" ? "stopped" : "ended" };
  if (working) return { icon: "●", color: "success", label: "working" };
  return { icon: "○", color: "warning", label: "waiting" };
}

/**
 * One selectable row in the "dock a PR agent" picker overlay. Built purely from
 * a registry snapshot + injected liveness/working/docked info so it can be
 * unit-tested without tmux. `value` is the agent's tmux pane id (what
 * `dockAgent` needs); `label`/`description` are the rendered SelectList text.
 */
export interface AgentPickerItem {
  /** The agent's tmux pane id — passed straight to dockAgent on confirm. */
  value: string;
  id: string;
  docked: boolean;
  marker: StatusMarker;
  label: string;
  description: string;
}

/**
 * Build the selectable list model for the dock picker from a registry snapshot.
 * Filters to LIVE depth-1 PR agents (via the injected `isAlive`), derives each
 * row's status marker exactly like the widget (statusMarker + injected
 * `isWorking`), marks the currently docked agent with a "(docked)" suffix, and
 * formats a one-line label (icon + status + id + PR + name). Pure: no tmux/UI IO
 * — all liveness/working/docked facts are injected so it is unit-testable.
 */
export function buildAgentPickerItems(
  entries: readonly PrEntry[],
  opts: {
    isAlive: (paneId: string) => boolean;
    isWorking: (paneId: string) => boolean;
    dockedPaneId?: string;
  },
): AgentPickerItem[] {
  const items: AgentPickerItem[] = [];
  for (const e of entries) {
    if (e.depth !== 1 || !e.paneId || !opts.isAlive(e.paneId)) continue;
    const marker = statusMarker(e.status, true, opts.isWorking(e.paneId));
    const docked = e.paneId === opts.dockedPaneId;
    const pr = e.prNumber !== undefined ? `PR #${e.prNumber}` : "pending";
    const suffix = docked ? " (docked)" : "";
    items.push({
      value: e.paneId,
      id: e.id,
      docked,
      marker,
      label: `${marker.icon} ${marker.label.padEnd(7)} ${e.id}  ${pr}  ${e.prName}${suffix}`,
      description: e.branch,
    });
  }
  return items;
}

/**
 * Latest commit title in a PR worktree, or "(no commits yet)" when the branch
 * has no commits beyond its base. Falls back safely if git fails.
 */
function latestCommitTitle(worktree: string, base: string): string {
  const count = tryGit(["rev-list", "--count", `${base}..HEAD`], worktree);
  if (count !== null && count.trim() === "0") return "(no commits yet)";
  const title = tryGit(["log", "-1", "--format=%s"], worktree);
  return title && title.length > 0 ? title : "(no commits yet)";
}

interface WidgetTheme {
  fg(color: string, text: string): string;
}

/**
 * Build the widget's lines for the current registry. Returns `undefined` when
 * there are no PR agents (so the caller clears the widget). Reads live pane and
 * git state; everything degrades gracefully if tmux/git calls fail.
 */
function renderPrWidget(cwd: string, theme: WidgetTheme, width: number): string[] | undefined {
  const entries = loadRegistry(cwd).filter((e) => e.depth === 1);
  if (entries.length === 0) return undefined;

  const cap = Math.max(20, width - 1);
  const lines: string[] = [theme.fg("accent", `● PR agents (${entries.length})`)];
  for (const e of entries) {
    const alive = paneAlive(e.paneId);
    // Capture a wide tail so isWorkingSnapshot can find the activity line that
    // sits above the input box (see WORKING_SCAN_LINES).
    const working = alive && isWorkingSnapshot(capturePane(e.paneId, 40));
    const m = statusMarker(e.status, alive, working);
    const pr = e.prNumber !== undefined ? `PR #${e.prNumber} ${e.status}` : "pending";
    const head = `${theme.fg(m.color, m.icon)} ${theme.fg(m.color, m.label.padEnd(7))} ${e.id}  ${pr}  ${e.prName}`;
    lines.push(truncateToWidth(head, cap));
    const sub = `    ${e.branch} · ${latestCommitTitle(e.worktree, e.base)}`;
    lines.push(truncateToWidth(theme.fg("dim", sub), cap, ""));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const level = depth();

  // Timer driving the orchestrator's live PR-agents list widget (depth 0 only).
  let widgetTimer: ReturnType<typeof setInterval> | undefined;

  // Separate, slower timer driving the GitHub PR-state poller (depth 0 only).
  let ghPollTimer: ReturnType<typeof setInterval> | undefined;

  // Subagent-only (depth 1): timer driving the review-comment loop that polls
  // THIS PR for new reviewer feedback AND its CI status once it has been pushed.
  let reviewPollTimer: ReturnType<typeof setInterval> | undefined;

  // Subagent-only (depth 1): in-memory seen-set of surfaced ids — review activity
  // (keyed rc:/rv:/ic:) and CI failures (keyed ci:<sha>:<name>) — plus the
  // resolved owner/repo. The seen-set is seeded from the entry's persisted
  // seenReviewIds and kept in sync with it (the poller, the CI loop, and the
  // reply tool all union new ids in), so a restart never reprocesses old comments
  // and the bot's own replies are never re-surfaced as new.
  const reviewSeen = new Set<string>();
  let reviewRepo: { owner: string; repo: string } | null = null;

  // Orchestrator-only: last-known GitHub state ("merged"/"closed"/"open") per PR
  // subagent id. Seeded from the registry at startup (terminal entries marked as
  // already-seen) so launching the orchestrator never replays a cleanup prompt
  // for an already merged/closed/stopped PR.
  const ghLastState = new Map<string, string>();

  // Orchestrator-only: last-seen resultSeq per PR subagent id, used to detect
  // and dedup newly-finished agents across refresh ticks. Initialized from the
  // registry at startup so pre-existing results never replay a notification
  // flood when the orchestrator launches.
  const lastSeenResult = new Map<string, number>();

  // Dispatched PR/helper subagents run in a worktree of a repo the user already
  // chose to work in, so auto-trust it instead of blocking on the trust prompt.
  // (Only fires for user/global and CLI extensions; the worker/helper commands
  // also pass `-a` to cover other load modes.)
  pi.on("project_trust", async (_event, _ctx) => {
    if (process.env.PI_PR_DEPTH && process.env.PI_PR_DEPTH !== "0") {
      return { trusted: "yes" } as const;
    }
    return { trusted: "undecided" } as const;
  });

  // ---- Common: tidy tmux titles when we're inside tmux ----------------
  pi.on("session_start", async (_event, ctx) => {
    if (insideTmux()) tmuxSetup();

    // Depth 0 inside tmux: capture the orchestrator's OWN pane id once. Every
    // dock/undock targets this pane and must never break/kill it.
    if (level === 0 && insideTmux() && !orchestratorPane) {
      orchestratorPane = process.env.TMUX_PANE || tryTmux(["display-message", "-p", "#{pane_id}"]) || undefined;
    }

    // The main agent never writes code directly: disable edit/write at depth 0
    // unless explicitly opted out. It orchestrates; subagents do the writing.
    if (level === 0 && !process.env.PI_PR_ALLOW_MAIN_EDITS) {
      const active = pi.getActiveTools().filter((t) => t !== "edit" && t !== "write");
      pi.setActiveTools(active);
    }

    // One-time offer (depth 0, has UI, started outside tmux): install a shell
    // `pi` wrapper so future runs launch inside tmux automatically. The PR-pane
    // workflow needs tmux, so we make it the default if the user agrees.
    if (level === 0 && ctx.hasUI && !insideTmux() && !process.env.PI_PR_NO_ALIAS_PROMPT) {
      const state = loadState();
      if (!state.aliasPrompted) {
        const shell = detectShell();
        const rc = shellRcPath(shell);
        const already = rc ? aliasInstalled(rc) : false;
        if (!already) {
          const ok = await ctx.ui.confirm(
            "Install pr-pi tmux wrapper?",
            `pi-pr-agents runs each PR subagent in its own tmux pane, so pi should run inside tmux.\n\nInstall a \`pr-pi\` command in ${rc ?? "your shell config"} that launches pi inside tmux (auto-launching tmux when you're not already in it)? Plain \`pi\` is left unchanged. (You can re-run it later with /pr-install-tmux-alias.)`,
          );
          if (ok) {
            const res = installTmuxAlias();
            ctx.ui.notify(res.message, res.ok ? "info" : "warning");
          }
        }
        saveState({ aliasPrompted: true });
      }
    }

    // Depth 0 with a UI: render a persistent, auto-refreshing list of the
    // dispatched PR agents above the editor (status marker + latest commit).
    if (level === 0 && ctx.hasUI && !widgetTimer) {
      // Seed last-seen from the current registry so existing results don't
      // replay as notifications the moment the orchestrator starts.
      for (const e of loadRegistry(ctx.cwd)) {
        if (e.depth === 1 && typeof e.resultSeq === "number") lastSeenResult.set(e.id, e.resultSeq);
      }
      const tick = () => {
        try {
          const width = process.stdout.columns ?? 100;
          const lines = renderPrWidget(ctx.cwd, ctx.ui.theme, width);
          ctx.ui.setWidget(WIDGET_KEY, lines);
        } catch {
          // tmux/git failures already degrade to null inside renderPrWidget;
          // never let the refresh loop throw.
        }
        // Maintenance: if the docked agent ended (pane gone), re-dock the most
        // recently created live agent, or collapse to the orchestrator alone.
        try {
          if (insideTmux() && orchestratorPane && dockedPaneId && !paneAlive(dockedPaneId)) {
            const next = pickRedockAgent(loadRegistry(ctx.cwd), paneAlive);
            if (next) dockAgent(ctx.cwd, next.paneId);
            else dockedPaneId = undefined;
          }
        } catch {
          // Never let dock maintenance break the refresh loop.
        }
        // Reuse this refresh tick to auto-notify the orchestrator whenever a PR
        // subagent finishes a turn. The seq + last-seen map dedups; isIdle
        // picks immediate vs. follow-up delivery so we never clobber a turn.
        try {
          const fresh = selectNewlyFinished(loadRegistry(ctx.cwd), lastSeenResult);
          if (fresh.length > 0) {
            for (const { entry, seq } of fresh) lastSeenResult.set(entry.id, seq);
            const msg = buildFinishedNotification(fresh.map((f) => f.entry));
            if (ctx.isIdle()) pi.sendUserMessage(msg);
            else pi.sendUserMessage(msg, { deliverAs: "followUp" });
          }
        } catch {
          // Never let a notification failure break the refresh loop.
        }
      };
      tick();
      widgetTimer = setInterval(tick, 2000);
    }

    // Depth 0 with a UI: poll GitHub for each live PR's state on a separate,
    // slower interval (gh calls are network-bound). When a PR is merged/closed
    // on GitHub, auto-notify the orchestrator to run cleanup immediately.
    if (level === 0 && ctx.hasUI && !ghPollTimer) {
      // Seed last-known state from the registry. Non-pollable entries (not yet
      // pushed, no number, or already terminal) are skipped so they never
      // trigger a gh call or a replayed cleanup prompt; pollable entries start
      // as "open" and are re-classified on the first tick (so a PR that merged
      // while the orchestrator was down still surfaces as a fresh transition).
      for (const e of loadRegistry(ctx.cwd)) {
        if (isPollable(e)) ghLastState.set(e.id, "open");
      }
      const ghTick = () => {
        try {
          // Classify each pollable PR subagent from a fresh gh read. Entries the
          // worker has not yet signalled with pr_pushed make zero gh calls.
          const classified: { entry: PrEntry; state: PrStateClass }[] = [];
          for (const e of loadRegistry(ctx.cwd)) {
            if (!isPollable(e)) continue;
            const json = runGh(["pr", "view", String(e.prNumber), "--json", "state,mergedAt,closedAt,url"], e.worktree);
            const state = classifyPrState(json);
            if (state === "unknown") continue; // gh missing/unauth/error — degrade silently
            classified.push({ entry: e, state });
          }
          const transitions = selectStateTransitions(classified, ghLastState);
          // Record every fresh state (incl. "open") so the map stays current.
          for (const { entry, state } of classified) ghLastState.set(entry.id, state);
          if (transitions.length === 0) return;
          // Persist terminal status so the widget reflects it, then self-notify.
          for (const { entry, state } of transitions) updateEntry(ctx.cwd, entry.id, { status: state });
          const msg = buildCleanupNotification(transitions);
          if (ctx.isIdle()) pi.sendUserMessage(msg);
          else pi.sendUserMessage(msg, { deliverAs: "followUp" });
        } catch {
          // Never let a gh/network/notification failure break the poll loop.
        }
      };
      ghTick();
      ghPollTimer = setInterval(ghTick, GH_POLL_MS);
    }

    // Depth 1 (a PR subagent): once THIS PR is pushed, poll it for new reviewer
    // feedback AND CI failures. When new inline comments arrive OR CI checks fail,
    // inject a fresh task to address + push (review: also reply without resolving
    // threads; CI: reproduce locally with the gate and fix). The timer fires while
    // the subagent is IDLE (it finished its task and waits in its hidden window),
    // so injecting via sendUserMessage starts a clean new turn rather than
    // blocking the current one.
    //
    // KNOWN LIMITATION: this loop only runs while the subagent process is alive.
    // If its pane was already killed (e.g. by /cleanup), new review comments and
    // CI failures are NOT auto-handled — re-spawning dead agents is out of scope.
    if (level === 1 && !reviewPollTimer) {
      // Inject a task into a fresh turn: immediately when idle, else queued as a
      // follow-up so the current turn is never clobbered.
      const inject = (msg: string) => {
        if (ctx.isIdle()) pi.sendUserMessage(msg);
        else pi.sendUserMessage(msg, { deliverAs: "followUp" });
      };

      // One tick polls BOTH the review-comment loop and the CI-failure loop. They
      // share the same gate (pushed + numbered + non-terminal), seen-set, and
      // owner/repo resolution; CI failures are deduped per commit via
      // ci:<sha>:<name> keys, so a still-failing check after a fix-push re-notifies
      // (new sha) while a passing run never does.
      const tick = () => {
        try {
          const myId = process.env.PI_PR_ID;
          if (!myId) return;
          const entry = loadRegistry(ctx.cwd).find((e) => e.id === myId);
          // Entry gone or terminal => nothing to do.
          if (!entry || entry.status === "merged" || entry.status === "closed" || entry.status === "stopped") return;
          // Only act once the PR actually exists (pushed + numbered).
          if (entry.pushed !== true || typeof entry.prNumber !== "number") return;

          // Seed/refresh the in-memory seen-set from the persisted union so a
          // restart never reprocesses old comments/failures and the reply tool's
          // writes are picked up.
          for (const sid of entry.seenReviewIds ?? []) reviewSeen.add(sid);

          // Resolve owner/repo once; gh missing/unauth => skip silently.
          if (!reviewRepo) reviewRepo = resolveOwnerRepo(ctx.cwd);
          if (!reviewRepo) return;

          // Review-comment loop: surface (and mark seen) only when there are NEW
          // actionable comments, so standalone context lingers until it
          // accompanies real work. Mark seen BEFORE injecting so a slow turn can't
          // double-surface on the next tick.
          const fetched = fetchReviewActivity(reviewRepo.owner, reviewRepo.repo, entry.prNumber, ctx.cwd);
          const { actionable, contextNotes, newIds } = selectNewReviewItems(fetched, reviewSeen);
          if (actionable.length > 0) {
            for (const nid of newIds) reviewSeen.add(nid);
            mergeSeenReviewIds(ctx.cwd, myId, newIds);
            inject(buildReviewTask(actionable, contextNotes, entry.prNumber));
          }

          // CI-failure loop: surface NEW failures for the current head commit.
          const ci = fetchCiChecks(entry.prNumber, ctx.cwd);
          if (ci) {
            const { failures, newKeys } = selectNewCiFailures(ci.checks, ci.headSha, reviewSeen);
            if (failures.length > 0) {
              for (const k of newKeys) reviewSeen.add(k);
              mergeSeenReviewIds(ctx.cwd, myId, newKeys);
              inject(buildCiFixTask(failures, entry.prNumber));
            }
          }
        } catch {
          // Never let a gh/network/notification failure break the poll loop.
        }
      };
      tick();
      reviewPollTimer = setInterval(tick, REVIEW_POLL_MS);
    }
  });

  // Tear down the refresh + poll timers and clear the widget on shutdown.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
    if (ghPollTimer) {
      clearInterval(ghPollTimer);
      ghPollTimer = undefined;
    }
    if (reviewPollTimer) {
      clearInterval(reviewPollTimer);
      reviewPollTimer = undefined;
    }
    // Return any docked agent to its own hidden window so a clean exit doesn't
    // leave a stray pane in the (closing) orchestrator window. Guarded.
    if (level === 0 && insideTmux()) {
      try {
        undockCurrent(ctx.cwd);
      } catch {
        // Never let dock teardown break shutdown.
      }
    }
    if (level === 0 && ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  // Manual (re)install command, available everywhere.
  pi.registerCommand("pr-install-tmux-alias", {
    description: "Install a shell `pr-pi` command that launches pi inside tmux",
    handler: async (_args, ctx) => {
      const res = installTmuxAlias();
      saveState({ aliasPrompted: true });
      ctx.ui.notify(res.message, res.ok ? "info" : "warning");
    },
  });

  // Set or show this project's default stacking strategy (github vs graphite).
  // The strategy only chooses the default `mode` when the orchestrator stacks
  // DEPENDENT PRs ("github" → "stack", "graphite" → "graphite"); standalone PRs
  // stay "independent" and an explicit dispatch_pr mode always wins.
  pi.registerCommand("pr-strategy", {
    description: "Set/show the project's PR stacking strategy (github | graphite)",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const arg = (args ?? "").trim().toLowerCase();

      // With an argument: validate, persist, confirm.
      if (arg) {
        if (arg !== "github" && arg !== "graphite") {
          ctx.ui.notify(`Unknown strategy '${arg}'. Use: /pr-strategy github | graphite`, "warning");
          return;
        }
        if (arg === "graphite" && !graphiteAvailable()) {
          ctx.ui.notify("Graphite CLI (`gt`) not found on PATH. Install it before choosing graphite.", "warning");
          return;
        }
        saveProjectConfig(cwd, { strategy: arg });
        ctx.ui.notify(`PR stacking strategy set to '${arg}' (${projectConfigPath(cwd)}).`, "info");
        return;
      }

      // No argument: show the current value, then prompt to choose.
      const current = loadProjectConfig(cwd).strategy;
      const hasGt = graphiteAvailable();
      const currentLine = current ? `Current PR stacking strategy: ${current}.` : "PR stacking strategy is not set.";

      if (!ctx.hasUI) {
        const gtNote = hasGt ? "" : " (graphite unavailable: `gt` not on PATH)";
        ctx.ui.notify(`${currentLine} Choose with: /pr-strategy github | graphite${gtNote}`, "info");
        return;
      }

      const options = hasGt ? ["github", "graphite"] : ["github"];
      const title = hasGt
        ? `${currentLine} Choose the stacking strategy:`
        : `${currentLine} (graphite unavailable — gt not on PATH). Choose:`;
      const choice = await ctx.ui.select(title, options);
      if (choice !== "github" && choice !== "graphite") return; // cancelled
      saveProjectConfig(cwd, { strategy: choice });
      ctx.ui.notify(`PR stacking strategy set to '${choice}' (${projectConfigPath(cwd)}).`, "info");
    },
  });

  // =====================================================================
  // DEPTH 0 — the main orchestrator
  // =====================================================================
  if (level === 0) {
    // Always-on orchestrator guidance: triage + how to use companion tools.
    pi.on("before_agent_start", async (event, ctx) => {
      const strategy = loadProjectConfig(ctx.cwd).strategy;
      const strategyLine = strategy
        ? `PR stacking strategy: ${strategy} (from .pi/pr-agents.json). Standalone PRs stay independent; an explicit dispatch_pr mode always wins.`
        : "PR stacking strategy: not set — run /pr-strategy to choose github vs graphite (defaults to github for stacking). Standalone PRs stay independent.";
      const header = [
        "# You are the PR-orchestrator (main agent)",
        "",
        strategyLine,
        "",
        "You never edit code yourself (edit/write are disabled). You split work into",
        "small pull requests and dispatch one dedicated worktree subagent per PR with",
        "`dispatch_pr`, then monitor/steer them (peek_pr_agent, send_to_pr_agent,",
        "stop_pr_agent, list_pr_agents) and run /cleanup as PRs merge.",
        "",
        "FIRST, triage the request:",
        "- One-off / short task: ask at most 0-2 quick clarifying questions with the",
        "  `ask_user` tool (if available), then get to work and dispatch a single PR.",
        "- Larger task needing planning: think about it first, then use `ask_user` to",
        "  ask the user what they want in detail, and iterate with them until you both",
        "  converge on a concrete plan BEFORE dispatching any subagents.",
        "",
        "Prefer the `ask_user` tool over plain questions when it is available.",
        "Before dispatching the PRs, ask the user once (via `ask_user`) whether each PR",
        "subagent should simplify its diff (via the simplify_diff tool) before opening the PR, then pass the",
        "same `simplify` value to every `dispatch_pr` call.",
        "If web research helps, use pi-web-access tools (web_search, fetch_content).",
        "",
        "Load the `pr-orchestrator` skill for the full workflow.",
      ].join("\n");
      return { systemPrompt: `${event.systemPrompt}\n\n${header}` };
    });

    registerTextTool(pi, {
      name: "dispatch_pr",
      label: "Dispatch PR agent",
      description:
        "Split off one PR of work and hand it to a dedicated subagent. Creates a git worktree + branch, opens a labelled tmux pane running `pi`, and seeds it with the task. The subagent commits atomically and opens the PR. Use mode 'independent' for a standalone PR off the base branch, 'stack' to stack a manual PR onto the previous one, or 'graphite' to build a Graphite stack with `gt`.",
      promptSnippet: "Hand one PR-sized chunk of work to its own worktree subagent in a tmux pane.",
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
        simplify: Type.Optional(
          Type.Boolean({
            description:
              "If true, the subagent calls the simplify_diff tool to get an inline simplification task for its diff, applies it, and commits the result before opening the PR (requires pi-simplify). Ask the user once up front, then pass the same value to every dispatch_pr.",
          }),
        ),
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
        // Worktrees now live at `<root>/.worktrees/<slug>`; keep that dir out of
        // git status before creating anything inside the repo.
        ensureWorktreesIgnored(root);
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
          simplify: params.simplify ?? false,
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
          `Follow the pr-worker skill. Make an atomic commit after every coherent change.${
            entry.simplify
              ? " Before opening the PR, call the simplify_diff tool to get an inline simplification task for your diff, apply it in the same turn, then commit the result as a `refactor: simplify` commit."
              : ""
          } When you open the PR, call set_pr_number so this pane gets labelled.`,
        ].join("\n");

        const command = buildWorkerCommand(entry, taskMsg);
        let paneId: string;
        try {
          paneId = openWindow(worktree, command, paneTitle(entry), windowName(entry));
        } catch (err) {
          tryGit(["worktree", "remove", "--force", worktree], root);
          tryGit(["branch", "-D", branch], root);
          return {
            content: [{ type: "text", text: `Failed to open tmux window: ${(err as Error).message}` }],
            isError: true,
          };
        }
        entry.paneId = paneId;
        saveRegistry(cwd, [...entries, entry]);

        // Auto-flip: dock the newest PR agent to the right of the orchestrator
        // (the previously-docked agent is returned to its hidden window).
        dockAgent(cwd, paneId);

        return {
          content: [
            {
              type: "text",
              text: [
                `Dispatched PR subagent in a background tmux window (orchestrator stays full-screen).`,
                `  id:       ${id}`,
                `  pr_name:  ${params.pr_name}`,
                `  branch:   ${branch}`,
                `  base:     ${base}`,
                `  mode:     ${mode}`,
                `  worktree: ${worktree}`,
                `  pane:     ${paneId}`,
                ``,
                `It shows up live in the "● PR agents" list widget. Use focus_pr_agent({id:"${id}"}) to bring it`,
                `full-screen, send_to_pr_agent to steer it, list_pr_agents to track status.`,
              ].join("\n"),
            },
          ],
          details: { id, branch, base, mode, paneId, worktree },
        };
      },
    });

    registerPaneControlTools(pi, {
      noun: "PR agent",
      idDescription: "PR id, branch, name, or #number.",
      resolve: (cwd, ref) => findEntry(loadRegistry(cwd), ref),
      list: {
        name: "list_pr_agents",
        label: "List PR agents",
        description:
          "List every dispatched PR subagent with its PR number/name, branch, mode, tmux pane and live status.",
        promptGuidelines: ["Use list_pr_agents to review the current set of in-flight PRs before dispatching more."],
        empty: "No PR agents dispatched yet.",
        entries: (cwd) => loadRegistry(cwd).filter((e) => e.depth === 1),
        row: (e) => {
          const alive = paneAlive(e.paneId) ? "live" : "ended";
          const pr = e.prNumber !== undefined ? `#${e.prNumber}` : "(no PR yet)";
          return `${e.id}  ${pr}  ${e.prName}\n      branch=${e.branch} base=${e.base} mode=${e.mode} pane=${e.paneId} status=${e.status}/${alive}`;
        },
        details: (entries) => ({ entries }),
      },
      peek: {
        name: "peek_pr_agent",
        label: "Peek PR agent",
        description:
          "Check in on a PR subagent by capturing the recent output of its tmux pane (what it's currently doing / its progress). Read-only; does not interrupt it.",
        promptGuidelines: ["Use peek_pr_agent to see a subagent's progress before steering or stopping it."],
        linesDescription: "How many recent lines to capture (default 60).",
        header: (e) => `--- ${e.prName} (${e.paneId}) ---`,
        paneDead: (paneId) => `Pane ${paneId} is no longer live.`,
        details: (e) => ({ id: e.id, paneId: e.paneId }),
      },
      send: {
        name: "send_to_pr_agent",
        label: "Send to PR agent",
        description:
          "Type a message into a PR subagent's pi session and submit it (steer it, answer a question, or give follow-up work).",
        promptGuidelines: [
          "Use send_to_pr_agent to give a running PR subagent follow-up instructions instead of editing code yourself.",
        ],
        messageDescription: "Message to send to the subagent.",
        success: (e) => `Sent to ${e.prName} (${e.paneId}).`,
        paneDead: (paneId) => `Pane ${paneId} is no longer live.`,
      },
      stop: {
        name: "stop_pr_agent",
        label: "Stop PR agent",
        description:
          "Stop a PR subagent. mode 'interrupt' aborts its current turn (Escape) but keeps the session alive so you can re-steer it with send_to_pr_agent; mode 'kill' closes the pane entirely (the worktree and branch are kept for inspection).",
        promptGuidelines: [
          "Use stop_pr_agent to halt a subagent that is going the wrong way, then send_to_pr_agent to redirect it.",
        ],
        paneDead: (paneId) => `Pane ${paneId} is no longer live.`,
        result: (mode, e) =>
          mode === "kill"
            ? `Killed ${e.prName} (${e.paneId}). Worktree ${e.worktree} and branch ${e.branch} are kept.`
            : `Interrupted ${e.prName} (${e.paneId}). Use send_to_pr_agent to give it new instructions.`,
      },
    });

    registerTextTool(pi, {
      name: "focus_pr_agent",
      label: "Focus PR agent",
      description: "Move the tmux focus to a PR subagent's pane so you can watch or talk to it.",
      parameters: Type.Object({
        id: Type.String({ description: "PR id, branch, name, or #number." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return withEntry(findEntry(loadRegistry(ctx.cwd), params.id), "PR agent", params.id, (entry) => {
          tryTmux(["select-window", "-t", entry.paneId]);
          const ok = tryTmux(["select-pane", "-t", entry.paneId]);
          return {
            content: [
              {
                type: "text",
                text: ok === null ? "Pane no longer exists." : `Focused ${entry.prName} (${entry.paneId}).`,
              },
            ],
          };
        });
      },
    });

    registerTextTool(pi, {
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

    // Open an anchored overlay listing the LIVE PR agents and dock the chosen
    // one to the RIGHT of the orchestrator (via the existing dockAgent, which
    // auto-undocks the previous one). Shared by the /pr-agents command and the
    // hotkey. Never throws: every failure degrades to a notify.
    const openDockPicker = async (ctx: ExtensionContext): Promise<void> => {
      try {
        if (!ctx.hasUI) return;
        if (!insideTmux() || !orchestratorPane) {
          ctx.ui.notify("Docking a PR agent requires running pi inside tmux.", "info");
          return;
        }
        const items = buildAgentPickerItems(loadRegistry(ctx.cwd), {
          isAlive: paneAlive,
          // Match the widget: scan a wide tail so the activity line is detected.
          isWorking: (paneId) => isWorkingSnapshot(capturePane(paneId, 40)),
          dockedPaneId,
        });
        if (items.length === 0) {
          ctx.ui.notify("No live PR agents", "info");
          return;
        }
        const selectItems: SelectItem[] = items.map((it) => ({
          value: it.value,
          label: it.label,
          description: it.description,
        }));

        // Load DynamicBorder lazily: importing a runtime value from
        // @earendil-works/pi-coding-agent at module top-level pulls undici into
        // the (Node-only) test process, which crashes on some Node versions.
        // A dynamic import inside the UI-only handler keeps the test graph clean.
        const { DynamicBorder } = await import("@earendil-works/pi-coding-agent");

        const chosen = await ctx.ui.custom<string | null>(
          (tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            container.addChild(new Text(theme.fg("accent", theme.bold("Dock a PR agent on the right")), 1, 0));
            const selectList = new SelectList(selectItems, Math.min(selectItems.length, 10), {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            });
            selectList.onSelect = (item) => done(item.value);
            selectList.onCancel = () => done(null);
            container.addChild(selectList);
            container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter dock • esc cancel"), 1, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            return {
              render: (w) => container.render(w),
              invalidate: () => container.invalidate(),
              handleInput: (data) => {
                selectList.handleInput(data);
                tui.requestRender();
              },
            };
          },
          {
            overlay: true,
            overlayOptions: { anchor: "right-center", width: "45%", minWidth: 36, maxHeight: "80%" },
          },
        );

        if (!chosen) return;
        dockAgent(ctx.cwd, chosen);
        const entry = entryByPane(ctx.cwd, chosen);
        ctx.ui.notify(`Docked ${entry ? entry.prName : chosen} on the right.`, "info");
      } catch {
        // Never throw out of a command/shortcut handler.
        ctx.ui.notify("Could not open the PR-agent dock picker.", "warning");
      }
    };

    pi.registerCommand("pr-agents", {
      description: "Pick which live PR agent docks to the right of the orchestrator",
      handler: async (_args, ctx) => openDockPicker(ctx),
    });

    // Hotkey for the same picker. ctrl+alt+a is unobtrusive and unbound by the
    // default keymap (see docs/keybindings.md); users can rebind via keybindings.
    pi.registerShortcut(Key.ctrlAlt("a"), {
      description: "Dock a PR agent to the right (PR-agents picker)",
      handler: async (ctx) => openDockPicker(ctx),
    });
  }

  // =====================================================================
  // DEPTH 1 — a PR subagent: can register its PR + spawn helpers
  // =====================================================================
  if (level === 1) {
    // Every time this PR subagent finishes a turn (initial task completion AND
    // after each steer), record its final result on its own registry entry so
    // the orchestrator can auto-notify itself. The shared registry file is the
    // only bridge between the two processes.
    pi.on("agent_end", async (event, ctx) => {
      const myId = process.env.PI_PR_ID;
      if (!myId) return;
      const result = extractFinalResult(event.messages ?? []);
      if (!result) return;
      const existing = loadRegistry(ctx.cwd).find((e) => e.id === myId);
      if (!existing) return; // entry missing (race) — skip silently
      updateEntry(ctx.cwd, myId, {
        lastResult: result,
        lastResultAt: new Date().toISOString(),
        resultSeq: (existing.resultSeq ?? -1) + 1,
      });
    });

    registerTextTool(pi, {
      name: "set_pr_number",
      label: "Set PR number",
      description:
        "Record the PR number (and url) you just opened so the main agent and this tmux pane are labelled correctly. Call this right after creating the pull request.",
      promptGuidelines: ["Use set_pr_number immediately after opening the pull request."],
      parameters: Type.Object({
        number: Type.Integer({ description: "The pull request number." }),
        prUrl: Type.Optional(Type.String({ description: "The pull request URL." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const myId = process.env.PI_PR_ID;
        if (!myId)
          return { content: [{ type: "text", text: "PI_PR_ID not set; cannot record PR number." }], isError: true };
        const entry = updateEntry(ctx.cwd, myId, {
          prNumber: params.number,
          prUrl: params.prUrl,
          status: "open",
        });
        if (entry && insideTmux() && entry.paneId) setPaneTitle(entry.paneId, paneTitle(entry));
        return { content: [{ type: "text", text: `Recorded PR #${params.number}.` }] };
      },
    });

    registerTextTool(pi, {
      name: "pr_pushed",
      label: "Mark PR pushed",
      description:
        "Signal that you have pushed your branch AND opened the pull request. Records the PR number/url on your entry and tells the orchestrator to start polling this PR for merge/close (and, later, review comments). Call this as the FINAL step after `git push` + `gh pr create`.",
      promptGuidelines: [
        "Use pr_pushed as the final step once the branch is pushed and the PR exists; it registers the number and starts orchestrator polling.",
      ],
      parameters: Type.Object({
        prNumber: Type.Integer({ description: "The pull request number." }),
        prUrl: Type.Optional(Type.String({ description: "The pull request URL." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const myId = process.env.PI_PR_ID;
        if (!myId)
          return { content: [{ type: "text", text: "PI_PR_ID not set; cannot mark PR as pushed." }], isError: true };
        const entry = updateEntry(ctx.cwd, myId, {
          prNumber: params.prNumber,
          prUrl: params.prUrl,
          pushed: true,
          pushedAt: new Date().toISOString(),
          status: "open",
        });
        if (entry && insideTmux() && entry.paneId) setPaneTitle(entry.paneId, paneTitle(entry));
        return {
          content: [
            {
              type: "text",
              text: `Marked PR #${params.prNumber}${params.prUrl ? ` (${params.prUrl})` : ""} as pushed; the orchestrator will now poll it for merge/close (and, later, review comments).`,
            },
          ],
        };
      },
    });

    registerTextTool(pi, {
      name: "simplify_diff",
      label: "Simplify diff",
      description:
        "Return an inline simplification task for this PR's diff (changed files + pi-simplify's guidance) so you can tidy the changed code before opening the PR. The task is returned as the tool RESULT — apply the simplifications in the SAME turn, run tests, commit them as an atomic 'refactor: simplify' commit, then continue. Does not run a slash command or wait. Typically used when the orchestrator requested simplification (PI_PR_SIMPLIFY=1).",
      promptGuidelines: [
        "Use simplify_diff to get an inline simplification task for your diff, then apply it immediately in the same turn before opening the PR (when PI_PR_SIMPLIFY=1).",
      ],
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        try {
          // Resolve the PR base ref from this worker's own registry entry. The
          // worker has already COMMITTED its work, so diff against the base
          // (not HEAD). Three-dot (merge-base) diff matches the PR's diff.
          const base = findEntry(loadRegistry(ctx.cwd), process.env.PI_PR_ID ?? "")?.base;
          let stdout: string | null = base ? tryGit(["diff", "--name-status", `${base}...HEAD`], ctx.cwd) : null;
          // Fall back like pi-simplify does when base is missing/errors.
          if (stdout === null) stdout = tryGit(["diff", "--name-status", "HEAD"], ctx.cwd);
          if (stdout === null) stdout = tryGit(["diff", "--name-status", "HEAD~1"], ctx.cwd);

          const files = parseChangedFiles(stdout ?? "");
          if (files.length === 0) {
            const vs = base ?? "HEAD";
            return { content: [{ type: "text", text: `No changes vs ${vs}; nothing to simplify.` }] };
          }
          return { content: [{ type: "text", text: buildSimplifyPrompt(files) }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to build simplify task: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    });

    registerTextTool(pi, {
      name: "reply_to_review_comment",
      label: "Reply to review comment",
      description:
        "Post an inline reply to a reviewer's comment thread on THIS PR (a short explanation of your fix or a clarifying question). Use after addressing the feedback in code and pushing. This does NOT resolve the thread — leave that to the reviewer.",
      promptGuidelines: [
        "Use reply_to_review_comment to reply to each inline review thread after addressing it; never resolve threads yourself.",
      ],
      parameters: Type.Object({
        commentId: Type.Integer({ description: "The numeric id of the inline review comment (from `rc:<id>`)." }),
        body: Type.String({ description: "Short reply: how you addressed it, or a clarifying question." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const myId = process.env.PI_PR_ID;
        if (!myId) return { content: [{ type: "text", text: "PI_PR_ID not set; cannot reply." }], isError: true };
        const entry = loadRegistry(ctx.cwd).find((e) => e.id === myId);
        if (!entry || typeof entry.prNumber !== "number") {
          return {
            content: [{ type: "text", text: "No pushed PR on record yet; open the PR (pr_pushed) first." }],
            isError: true,
          };
        }
        const repo = reviewRepo ?? resolveOwnerRepo(ctx.cwd);
        if (!repo) {
          return {
            content: [{ type: "text", text: "Could not resolve owner/repo via gh (missing/unauthenticated?)." }],
            isError: true,
          };
        }
        reviewRepo = repo;
        const replyId = postReviewReply(repo.owner, repo.repo, entry.prNumber, params.commentId, params.body, ctx.cwd);
        if (replyId === null) {
          return {
            content: [{ type: "text", text: `Failed to post reply to comment ${params.commentId} (gh error).` }],
            isError: true,
          };
        }
        // Record our own reply id so the poller never treats it as a new comment.
        reviewSeen.add(`rc:${replyId}`);
        mergeSeenReviewIds(ctx.cwd, myId, [`rc:${replyId}`]);
        return {
          content: [
            {
              type: "text",
              text: `Replied to comment ${params.commentId} (reply id ${replyId}). Thread left unresolved.`,
            },
          ],
        };
      },
    });

    registerTextTool(pi, {
      name: "dispatch_helper",
      label: "Dispatch helper subagent",
      description:
        "Spawn a helper subagent in THIS same worktree (e.g. to explore, draft, or review part of the PR) as a new tmux pane. Helpers cannot dispatch further subagents (max depth reached).",
      promptSnippet: "Spawn a helper subagent in this worktree for a focused sub-task.",
      promptGuidelines: [
        "Use dispatch_helper only for sub-tasks of the current PR; helpers cannot spawn their own subagents.",
      ],
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
          return {
            content: [{ type: "text", text: `Failed to open helper pane: ${(err as Error).message}` }],
            isError: true,
          };
        }
        const hid = randomUUID().slice(0, 8);
        const entry: PrEntry = {
          id: hid,
          prName: params.name,
          branch: "",
          base: "",
          mode: "helper",
          paneId,
          worktree: ctx.cwd,
          depth: 2,
          parentId,
          status: "working",
          createdAt: new Date().toISOString(),
        };
        saveRegistry(ctx.cwd, [...loadRegistry(ctx.cwd), entry]);
        return {
          content: [
            {
              type: "text",
              text: `Spawned helper '${params.name}' (id ${hid}) in pane ${paneId}. Monitor it with list_helpers / peek_helper, steer it with send_to_helper, stop it with stop_helper. It cannot spawn further agents.`,
            },
          ],
          details: { id: hid, paneId },
        };
      },
    });

    const myHelpers = (cwd: string) => {
      const me = process.env.PI_PR_ID ?? "root";
      return loadRegistry(cwd).filter((e) => e.depth === 2 && e.parentId === me);
    };

    registerPaneControlTools(pi, {
      noun: "helper",
      idDescription: "Helper id or name.",
      resolve: (cwd, ref) => findEntry(myHelpers(cwd), ref),
      list: {
        name: "list_helpers",
        label: "List helpers",
        description: "List the helper subagents you spawned in this worktree, with their pane and live status.",
        empty: "No helpers spawned.",
        entries: (cwd) => myHelpers(cwd),
        row: (e) => `${e.id}  ${e.prName}  pane=${e.paneId}  ${paneAlive(e.paneId) ? "live" : "ended"}`,
      },
      peek: {
        name: "peek_helper",
        label: "Peek helper",
        description: "Check in on a helper subagent by capturing the recent output of its pane. Read-only.",
        linesDescription: "Recent lines to capture (default 60).",
        header: (e) => `--- helper ${e.prName} (${e.paneId}) ---`,
        paneDead: (paneId) => `Pane ${paneId} no longer live.`,
      },
      send: {
        name: "send_to_helper",
        label: "Send to helper",
        description: "Type a message into a helper subagent's session and submit it.",
        messageDescription: "Message to send.",
        success: (e) => `Sent to helper ${e.prName} (${e.paneId}).`,
        paneDead: (paneId) => `Pane ${paneId} no longer live.`,
      },
      stop: {
        name: "stop_helper",
        label: "Stop helper",
        description:
          "Stop a helper subagent. mode 'interrupt' aborts its current turn (Escape); mode 'kill' closes its pane.",
        paneDead: (paneId) => `Pane ${paneId} no longer live.`,
        result: (mode, e) => `${mode === "kill" ? "Killed" : "Interrupted"} helper ${e.prName} (${e.paneId}).`,
      },
    });
  }

  // Depth >= 2 (helpers): no dispatch tools are registered — they just work.
}
