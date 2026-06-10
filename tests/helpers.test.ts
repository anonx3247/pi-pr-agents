import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  type PrEntry,
  aliasBlock,
  buildAgentPickerItems,
  buildCleanupNotification,
  buildFinishedNotification,
  capTail,
  classifyPrState,
  detectShell,
  entriesForSession,
  extractFinalResult,
  findEntry,
  isPollable,
  isWorkingSnapshot,
  loadProjectConfig,
  loadRegistry,
  paneTitle,
  pickRedockAgent,
  projectConfigPath,
  resolveOrchestratorSessionId,
  saveProjectConfig,
  saveRegistry,
  selectNewlyFinished,
  selectStateTransitions,
  shq,
  slugify,
  statusMarker,
  updateEntry,
  windowName,
  worktreesDirFrom,
} from "../extensions/pr-agents.ts";

describe("slugify", () => {
  test("lowercases and replaces non-alphanumerics with single dashes", () => {
    assert.equal(slugify("Hello World"), "hello-world");
    assert.equal(slugify("Foo___Bar  Baz"), "foo-bar-baz");
    assert.equal(slugify("MixedCASE123"), "mixedcase123");
  });

  test("trims leading and trailing dashes", () => {
    assert.equal(slugify("  spaced  "), "spaced");
    assert.equal(slugify("--leading-and-trailing--"), "leading-and-trailing");
  });

  test("caps length at 48 characters", () => {
    const long = "a".repeat(100);
    assert.equal(slugify(long).length, 48);
  });

  test("falls back to 'pr' for empty or all-symbol input", () => {
    assert.equal(slugify(""), "pr");
    assert.equal(slugify("!!!@@@###"), "pr");
  });
});

describe("shq", () => {
  test("wraps a plain string in single quotes", () => {
    assert.equal(shq("hello"), "'hello'");
  });

  test("escapes embedded single quotes", () => {
    assert.equal(shq("it's"), "'it'\\''s'");
  });

  test("escapes multiple single quotes", () => {
    assert.equal(shq("a'b'c"), "'a'\\''b'\\''c'");
  });
});

describe("paneTitle", () => {
  test("includes the PR number when set", () => {
    assert.equal(paneTitle({ prNumber: 42, prName: "add tests", branch: "pi/tests" }), "PR#42 add tests (pi/tests)");
  });

  test("omits the number when prNumber is undefined", () => {
    assert.equal(
      paneTitle({ prNumber: undefined, prName: "add tests", branch: "pi/tests" }),
      "PR add tests (pi/tests)",
    );
  });
});

describe("windowName", () => {
  test("uses prN tag with a slugified name when a PR number is set", () => {
    assert.equal(windowName({ prNumber: 12, prName: "Add Rate Limiter", branch: "pi/rate" }), "pr12-add-rate-limiter");
  });

  test("falls back to a 'pr' tag and the branch when no name/number", () => {
    assert.equal(windowName({ prNumber: undefined, prName: "", branch: "pi/feature" }), "pr-pi-feature");
  });

  test("caps length and trims trailing dashes", () => {
    const name = windowName({ prNumber: undefined, prName: "x".repeat(80), branch: "b" });
    assert.ok(name.length <= 24);
    assert.ok(!name.endsWith("-"));
  });
});

describe("isWorkingSnapshot", () => {
  test("returns false for null or empty snapshots", () => {
    assert.equal(isWorkingSnapshot(null), false);
    assert.equal(isWorkingSnapshot(""), false);
    assert.equal(isWorkingSnapshot("just some idle output\n> "), false);
  });

  test("detects braille spinner glyphs in the recent tail", () => {
    assert.equal(isWorkingSnapshot("line\n⠹ thinking"), true);
  });

  test("detects the Working / Esc to interrupt activity line", () => {
    assert.equal(isWorkingSnapshot("Working (12s · Esc to interrupt)"), true);
    assert.equal(isWorkingSnapshot("foo\nbar\nesc to interrupt"), true);
  });

  test("detects an activity line that sits above the input box (not in the last 6 lines)", () => {
    // pi renders `⠋ Working… / Esc to interrupt` ~8-10 lines from the bottom,
    // above the input box; the wide scan window still finds it.
    const snap = `⠋ Working… (12s · Esc to interrupt)\n${Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n")}`;
    assert.equal(snap.split("\n").slice(-6).includes("⠋ Working… (12s · Esc to interrupt)"), false);
    assert.equal(isWorkingSnapshot(snap), true);
  });

  test("ignores activity that scrolled out of the wide tail", () => {
    const old = `Working\n${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}`;
    assert.equal(isWorkingSnapshot(old), false);
  });
});

describe("statusMarker", () => {
  test("terminal registry states win over liveness", () => {
    assert.deepEqual(statusMarker("merged", true, true), { icon: "✓", color: "success", label: "merged" });
    assert.deepEqual(statusMarker("closed", true, false), { icon: "✗", color: "error", label: "closed" });
  });

  test("dead panes are stopped/ended", () => {
    assert.equal(statusMarker("stopped", false, false).label, "stopped");
    assert.equal(statusMarker("open", false, false).label, "ended");
    assert.equal(statusMarker("working", false, false).icon, "■");
  });

  test("live panes reflect the working spinner", () => {
    assert.deepEqual(statusMarker("working", true, true), { icon: "●", color: "success", label: "working" });
    assert.deepEqual(statusMarker("open", true, false), { icon: "○", color: "warning", label: "waiting" });
  });
});

describe("pickRedockAgent", () => {
  const mk = (id: string, paneId: string, createdAt: string, d = 1): PrEntry =>
    ({
      id,
      prName: id,
      branch: id,
      base: "main",
      mode: "independent",
      paneId,
      worktree: `/wt/${id}`,
      depth: d,
      parentId: "root",
      status: "working",
      createdAt,
    }) as PrEntry;

  test("returns the most recently created live depth-1 agent", () => {
    const entries = [
      mk("a", "%1", "2026-01-01T00:00:00Z"),
      mk("b", "%2", "2026-03-01T00:00:00Z"),
      mk("c", "%3", "2026-02-01T00:00:00Z"),
    ];
    assert.equal(pickRedockAgent(entries, () => true)?.id, "b");
  });

  test("skips dead panes and non-depth-1 entries", () => {
    const entries = [
      mk("a", "%1", "2026-01-01T00:00:00Z"),
      mk("helper", "%2", "2026-09-01T00:00:00Z", 2),
      mk("b", "%3", "2026-02-01T00:00:00Z"),
    ];
    const alive = (p: string) => p !== "%1";
    assert.equal(pickRedockAgent(entries, alive)?.id, "b");
  });

  test("returns undefined when there are no live agents", () => {
    const entries = [mk("a", "%1", "2026-01-01T00:00:00Z")];
    assert.equal(
      pickRedockAgent(entries, () => false),
      undefined,
    );
    assert.equal(
      pickRedockAgent([], () => true),
      undefined,
    );
  });
});

describe("pickRedockAgent", () => {
  const mk = (id: string, paneId: string, createdAt: string, d = 1): PrEntry =>
    ({
      id,
      prName: id,
      branch: id,
      base: "main",
      mode: "independent",
      paneId,
      worktree: `/wt/${id}`,
      depth: d,
      parentId: "root",
      status: "working",
      createdAt,
    }) as PrEntry;

  test("returns the most recently created live depth-1 agent", () => {
    const entries = [
      mk("a", "%1", "2026-01-01T00:00:00Z"),
      mk("b", "%2", "2026-03-01T00:00:00Z"),
      mk("c", "%3", "2026-02-01T00:00:00Z"),
    ];
    assert.equal(pickRedockAgent(entries, () => true)?.id, "b");
  });

  test("skips dead panes and non-depth-1 entries", () => {
    const entries = [
      mk("a", "%1", "2026-01-01T00:00:00Z"),
      mk("helper", "%2", "2026-09-01T00:00:00Z", 2),
      mk("b", "%3", "2026-02-01T00:00:00Z"),
    ];
    const alive = (p: string) => p !== "%1";
    assert.equal(pickRedockAgent(entries, alive)?.id, "b");
  });

  test("returns undefined when there are no live agents", () => {
    const entries = [mk("a", "%1", "2026-01-01T00:00:00Z")];
    assert.equal(
      pickRedockAgent(entries, () => false),
      undefined,
    );
    assert.equal(
      pickRedockAgent([], () => true),
      undefined,
    );
  });
});

describe("buildAgentPickerItems", () => {
  const mk = (id: string, paneId: string, over: Partial<PrEntry> = {}): PrEntry =>
    ({
      id,
      prName: `pr-${id}`,
      branch: `branch-${id}`,
      base: "main",
      mode: "independent",
      paneId,
      worktree: `/wt/${id}`,
      depth: 1,
      parentId: "root",
      status: "working",
      createdAt: "2026-01-01T00:00:00Z",
      ...over,
    }) as PrEntry;

  test("filters to live depth-1 agents only", () => {
    const entries = [mk("a", "%1"), mk("helper", "%2", { depth: 2 }), mk("dead", "%3"), mk("nopane", "")];
    const items = buildAgentPickerItems(entries, {
      isAlive: (p) => p === "%1",
      isWorking: () => false,
    });
    assert.deepEqual(
      items.map((i) => i.id),
      ["a"],
    );
    assert.equal(items[0].value, "%1");
  });

  test("marks the docked agent with a (docked) suffix", () => {
    const entries = [mk("a", "%1"), mk("b", "%2")];
    const items = buildAgentPickerItems(entries, {
      isAlive: () => true,
      isWorking: () => false,
      dockedPaneId: "%2",
    });
    const a = items.find((i) => i.id === "a");
    const b = items.find((i) => i.id === "b");
    assert.equal(a?.docked, false);
    assert.equal(b?.docked, true);
    assert.ok(b?.label.endsWith("(docked)"));
    assert.ok(!a?.label.includes("(docked)"));
  });

  test("formats the label via statusMarker and exposes branch as description", () => {
    const entries = [mk("a", "%1", { prNumber: 12, status: "open" })];
    const working = buildAgentPickerItems(entries, { isAlive: () => true, isWorking: () => true });
    assert.equal(working[0].marker.label, "working");
    assert.equal(working[0].label, "● working a  PR #12  pr-a");
    assert.equal(working[0].description, "branch-a");

    const waiting = buildAgentPickerItems(entries, { isAlive: () => true, isWorking: () => false });
    assert.equal(waiting[0].marker.label, "waiting");
    assert.equal(waiting[0].label, "○ waiting a  PR #12  pr-a");
  });

  test("shows 'pending' when no PR number is recorded yet", () => {
    const items = buildAgentPickerItems([mk("a", "%1")], { isAlive: () => true, isWorking: () => false });
    assert.ok(items[0].label.includes("pending"));
  });
});

describe("findEntry", () => {
  const entries: PrEntry[] = [
    {
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      prName: "feature one",
      branch: "pi/feature-one",
      base: "main",
      mode: "stack",
      paneId: "%1",
      worktree: "/tmp/wt1",
      depth: 1,
      parentId: "",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      prNumber: 7,
    },
    {
      id: "99999999-0000-0000-0000-000000000000",
      prName: "feature two",
      branch: "pi/feature-two",
      base: "main",
      mode: "independent",
      paneId: "%2",
      worktree: "/tmp/wt2",
      depth: 1,
      parentId: "",
      status: "working",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  test("matches by full id", () => {
    assert.equal(findEntry(entries, entries[0].id)?.prName, "feature one");
  });

  test("matches by id prefix", () => {
    assert.equal(findEntry(entries, "abcdef12")?.prName, "feature one");
  });

  test("matches by branch", () => {
    assert.equal(findEntry(entries, "pi/feature-two")?.prName, "feature two");
  });

  test("matches by prName", () => {
    assert.equal(findEntry(entries, "feature one")?.branch, "pi/feature-one");
  });

  test("matches by prNumber with and without a leading #", () => {
    assert.equal(findEntry(entries, "7")?.prName, "feature one");
    assert.equal(findEntry(entries, "#7")?.prName, "feature one");
  });

  test("returns undefined when nothing matches", () => {
    assert.equal(findEntry(entries, "nope"), undefined);
    assert.equal(findEntry(entries, "#999"), undefined);
  });
});

describe("aliasBlock", () => {
  const BEGIN = "# >>> pi-pr-agents tmux wrapper >>>";
  const END = "# <<< pi-pr-agents tmux wrapper <<<";

  test("fish block defines a wrapping function and markers", () => {
    const block = aliasBlock("fish");
    assert.ok(block.includes("function pr-pi --wraps pi"));
    assert.ok(block.includes(BEGIN));
    assert.ok(block.includes(END));
  });

  test("fish block opts into PR_PI_SESSION and uses a random suffix by default", () => {
    const block = aliasBlock("fish");
    assert.ok(block.includes("PR_PI_SESSION"));
    assert.ok(block.includes("(random)"));
  });

  for (const kind of ["zsh", "bash"] as const) {
    test(`${kind} block defines a pr-pi() function and markers`, () => {
      const block = aliasBlock(kind);
      assert.ok(block.includes("pr-pi() {"));
      assert.ok(block.includes(BEGIN));
      assert.ok(block.includes(END));
    });

    test(`${kind} block opts into PR_PI_SESSION and uses a $RANDOM suffix by default`, () => {
      const block = aliasBlock(kind);
      assert.ok(block.includes("PR_PI_SESSION"));
      assert.ok(block.includes("$RANDOM"));
    });
  }
});

describe("detectShell", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.SHELL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  });

  test("detects zsh", () => {
    process.env.SHELL = "/bin/zsh";
    assert.equal(detectShell(), "zsh");
  });

  test("detects bash", () => {
    process.env.SHELL = "/usr/bin/bash";
    assert.equal(detectShell(), "bash");
  });

  test("detects fish", () => {
    process.env.SHELL = "/opt/homebrew/bin/fish";
    assert.equal(detectShell(), "fish");
  });

  test("returns unknown for unrecognized or unset shells", () => {
    process.env.SHELL = "/bin/sh";
    assert.equal(detectShell(), "unknown");
    delete process.env.SHELL;
    assert.equal(detectShell(), "unknown");
  });
});

describe("capTail", () => {
  test("returns the string unchanged when within the cap", () => {
    assert.equal(capTail("hello", 10), "hello");
    assert.equal(capTail("exactly10!", 10), "exactly10!");
  });

  test("keeps the tail and marks the cut, staying within the cap", () => {
    const out = capTail("abcdefghij", 5);
    assert.equal(out.length, 5);
    assert.ok(out.startsWith("\u2026"));
    assert.ok(out.endsWith("j"));
  });
});

describe("extractFinalResult", () => {
  test("concatenates text parts of the last assistant message", () => {
    const messages = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Done. " },
          { type: "toolCall", id: "x", name: "y", arguments: {} },
          { type: "text", text: "Opened PR #42." },
        ],
      },
    ];
    assert.equal(extractFinalResult(messages), "Done. Opened PR #42.");
  });

  test("supports a plain string assistant content", () => {
    assert.equal(extractFinalResult([{ role: "assistant", content: "  summary  " }]), "summary");
  });

  test("returns empty string when there is no assistant text", () => {
    assert.equal(extractFinalResult([]), "");
    assert.equal(extractFinalResult([{ role: "user", content: "hi" }]), "");
    assert.equal(extractFinalResult([{ role: "assistant", content: [{ type: "text", text: "   " }] }]), "");
    assert.equal(
      extractFinalResult([{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "b", arguments: {} }] }]),
      "",
    );
  });

  test("caps to the tail keeping the final summary", () => {
    const long = `${"x".repeat(50)} FINAL`;
    const out = extractFinalResult([{ role: "assistant", content: [{ type: "text", text: long }] }], 10);
    assert.equal(out.length, 10);
    assert.ok(out.endsWith("FINAL"));
  });
});

describe("selectNewlyFinished", () => {
  function entry(id: string, depth: number, resultSeq?: number): PrEntry {
    return {
      id,
      prName: `pr ${id}`,
      branch: `pi/${id}`,
      base: "main",
      mode: "stack",
      paneId: "%1",
      worktree: "/tmp",
      depth,
      parentId: "",
      status: "working",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...(resultSeq !== undefined ? { resultSeq } : {}),
    };
  }

  test("returns entries whose resultSeq exceeds the last-seen value", () => {
    const entries = [entry("a", 1, 0), entry("b", 1, 2)];
    const fresh = selectNewlyFinished(entries, new Map([["b", 1]]));
    assert.deepEqual(
      fresh.map((f) => [f.entry.id, f.seq]),
      [
        ["a", 0],
        ["b", 2],
      ],
    );
  });

  test("skips entries already seen at the same seq (dedup)", () => {
    const entries = [entry("a", 1, 3)];
    assert.deepEqual(selectNewlyFinished(entries, new Map([["a", 3]])), []);
  });

  test("ignores non-depth-1 entries and entries without a resultSeq", () => {
    const entries = [entry("helper", 2, 5), entry("noseq", 1, undefined)];
    assert.deepEqual(selectNewlyFinished(entries, new Map()), []);
  });
});

describe("buildFinishedNotification", () => {
  function finished(id: string, patch: Partial<PrEntry>): PrEntry {
    return {
      id,
      prName: `pr ${id}`,
      branch: `pi/${id}`,
      base: "main",
      mode: "stack",
      paneId: "%1",
      worktree: "/tmp",
      depth: 1,
      parentId: "",
      status: "working",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...patch,
    };
  }

  test("single agent: includes id, PR number, name, branch, and result", () => {
    const msg = buildFinishedNotification([
      finished("aaa", { prNumber: 42, prName: "add limiter", branch: "pi/limiter", lastResult: "all green" }),
    ]);
    assert.ok(msg.startsWith("A PR subagent stopped working:"));
    assert.ok(msg.includes("id aaa"));
    assert.ok(msg.includes("PR #42"));
    assert.ok(msg.includes("add limiter"));
    assert.ok(msg.includes("pi/limiter"));
    assert.ok(msg.includes("all green"));
    assert.ok(msg.includes("Do not take destructive actions without cause."));
  });

  test("shows 'pending' when no PR number and a placeholder for a missing result", () => {
    const msg = buildFinishedNotification([finished("bbb", {})]);
    assert.ok(msg.includes("PR pending"));
    assert.ok(msg.includes("(no result captured)"));
  });

  test("combines multiple agents into one message", () => {
    const msg = buildFinishedNotification([
      finished("aaa", { lastResult: "one" }),
      finished("bbb", { lastResult: "two" }),
    ]);
    assert.ok(msg.startsWith("2 PR subagents stopped working:"));
    assert.ok(msg.includes("id aaa"));
    assert.ok(msg.includes("id bbb"));
  });
});

describe("classifyPrState", () => {
  test("non-null mergedAt always means merged", () => {
    assert.equal(classifyPrState({ state: "OPEN", mergedAt: "2026-01-01T00:00:00Z" }), "merged");
  });

  test("maps gh state strings (case-insensitive)", () => {
    assert.equal(classifyPrState({ state: "MERGED", mergedAt: null }), "merged");
    assert.equal(classifyPrState({ state: "CLOSED", mergedAt: null }), "closed");
    assert.equal(classifyPrState({ state: "OPEN", mergedAt: null }), "open");
    assert.equal(classifyPrState({ state: "open" }), "open");
  });

  test("returns 'unknown' for null, non-objects, and unrecognized states", () => {
    assert.equal(classifyPrState(null), "unknown");
    assert.equal(classifyPrState("OPEN"), "unknown");
    assert.equal(classifyPrState({ state: "DRAFT" }), "unknown");
    assert.equal(classifyPrState({}), "unknown");
  });
});

describe("isPollable", () => {
  function entry(patch: Partial<PrEntry>): PrEntry {
    return {
      id: "x",
      prName: "pr x",
      branch: "pi/x",
      base: "main",
      mode: "independent",
      paneId: "%1",
      worktree: "/tmp",
      depth: 1,
      parentId: "root",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...patch,
    };
  }

  test("pushed + numeric prNumber + open => true", () => {
    assert.equal(isPollable(entry({ pushed: true, prNumber: 7, status: "open" })), true);
  });

  test("not pushed => false (zero gh calls before pr_pushed)", () => {
    assert.equal(isPollable(entry({ prNumber: 7, status: "open" })), false);
    assert.equal(isPollable(entry({ pushed: false, prNumber: 7, status: "open" })), false);
  });

  test("terminal status => false", () => {
    assert.equal(isPollable(entry({ pushed: true, prNumber: 7, status: "merged" })), false);
    assert.equal(isPollable(entry({ pushed: true, prNumber: 7, status: "closed" })), false);
    assert.equal(isPollable(entry({ pushed: true, prNumber: 7, status: "stopped" })), false);
  });

  test("missing prNumber => false", () => {
    assert.equal(isPollable(entry({ pushed: true, status: "open" })), false);
  });

  test("non-depth-1 entries are not pollable", () => {
    assert.equal(isPollable(entry({ pushed: true, prNumber: 7, status: "open", depth: 2 })), false);
  });
});

describe("selectStateTransitions", () => {
  function entry(id: string, patch: Partial<PrEntry> = {}): PrEntry {
    return {
      id,
      prName: `pr ${id}`,
      branch: `pi/${id}`,
      base: "main",
      mode: "independent",
      paneId: "%1",
      worktree: "/tmp",
      depth: 1,
      parentId: "root",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...patch,
    };
  }

  test("selects entries that newly reached a terminal state", () => {
    const classified = [
      { entry: entry("a", { prNumber: 1 }), state: "merged" as const },
      { entry: entry("b", { prNumber: 2 }), state: "closed" as const },
      { entry: entry("c", { prNumber: 3 }), state: "open" as const },
    ];
    const out = selectStateTransitions(classified, new Map([["a", "open"]]));
    assert.deepEqual(
      out.map((t) => [t.entry.id, t.state]),
      [
        ["a", "merged"],
        ["b", "closed"],
      ],
    );
  });

  test("dedups entries already known to be in that terminal state", () => {
    const classified = [{ entry: entry("a"), state: "merged" as const }];
    assert.deepEqual(selectStateTransitions(classified, new Map([["a", "merged"]])), []);
  });

  test("ignores non-terminal (open/unknown) states", () => {
    const classified = [
      { entry: entry("a"), state: "open" as const },
      { entry: entry("b"), state: "unknown" as const },
    ];
    assert.deepEqual(selectStateTransitions(classified, new Map()), []);
  });
});

describe("buildCleanupNotification", () => {
  function entry(id: string, patch: Partial<PrEntry> = {}): PrEntry {
    return {
      id,
      prName: `pr ${id}`,
      branch: `pi/${id}`,
      base: "main",
      mode: "independent",
      paneId: "%1",
      worktree: "/tmp",
      depth: 1,
      parentId: "root",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...patch,
    };
  }

  test("single transition names the PR, branch, state and cleanup tool", () => {
    const msg = buildCleanupNotification([
      { entry: entry("a", { prNumber: 42, prName: "add limiter", branch: "pi/limiter" }), state: "merged" },
    ]);
    assert.ok(msg.includes("PR #42 'add limiter' (branch pi/limiter) was merged on GitHub."));
    assert.ok(msg.includes("cleanup_pr_worktrees"));
  });

  test("combines multiple transitions into one message", () => {
    const msg = buildCleanupNotification([
      { entry: entry("a", { prNumber: 1 }), state: "merged" },
      { entry: entry("b", { prNumber: 2 }), state: "closed" },
    ]);
    assert.ok(msg.includes("PR #1 'pr a' (branch pi/a) was merged on GitHub."));
    assert.ok(msg.includes("PR #2 'pr b' (branch pi/b) was closed on GitHub."));
    // Plural cleanup wording for a coalesced multi-PR (stack) notification.
    assert.ok(msg.includes("remove their worktrees, branches, and tmux windows"));
  });

  test("uses a placeholder when the PR number is missing", () => {
    const msg = buildCleanupNotification([{ entry: entry("a", { prNumber: undefined }), state: "merged" }]);
    assert.ok(msg.includes("PR (no number) 'pr a'"));
  });
});

describe("registry round-trip", () => {
  let dir: string;
  // git exports these when the suite runs under a hook (e.g. simple-git-hooks'
  // pre-push runs `npm test`). They override cwd, so `git rev-parse
  // --git-common-dir` would resolve to the REAL repo and registry writes would
  // escape the temp dir. Clear them here and restore exactly in afterEach.
  const GIT_ENV_VARS = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;
  let savedGitEnv: Record<string, string | undefined>;

  function makeEntry(id: string): PrEntry {
    return {
      id,
      prName: `pr ${id}`,
      branch: `pi/${id}`,
      base: "main",
      mode: "stack",
      paneId: "%1",
      worktree: dir,
      depth: 1,
      parentId: "",
      status: "working",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  beforeEach(() => {
    savedGitEnv = {};
    for (const key of GIT_ENV_VARS) {
      savedGitEnv[key] = process.env[key];
      delete process.env[key];
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-agents-test-"));
    // registryPath derives its dir from gitCommonDir(cwd), which shells out to
    // git, so initialise a real (empty, quiet) repo to keep the test hermetic.
    // Pass an explicit env without the git location vars so init resolves
    // against the temp dir's cwd, not an inherited repo.
    execFileSync("git", ["init", "-q"], { cwd: dir, env: process.env });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of GIT_ENV_VARS) {
      const value = savedGitEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("saveRegistry/loadRegistry round-trips entries", () => {
    const entries = [makeEntry("aaa"), makeEntry("bbb")];
    saveRegistry(dir, entries);
    assert.deepEqual(loadRegistry(dir), entries);
  });

  test("updateEntry patches a single field", () => {
    saveRegistry(dir, [makeEntry("aaa")]);
    const updated = updateEntry(dir, "aaa", { prNumber: 13, status: "open" });
    assert.equal(updated?.prNumber, 13);
    assert.equal(updated?.status, "open");
    const reloaded = loadRegistry(dir);
    assert.equal(reloaded[0].prNumber, 13);
    assert.equal(reloaded[0].status, "open");
  });

  test("updateEntry returns undefined for an unknown id", () => {
    saveRegistry(dir, [makeEntry("aaa")]);
    assert.equal(updateEntry(dir, "missing", { prNumber: 1 }), undefined);
  });

  test("loadRegistry returns [] when no registry file exists", () => {
    assert.deepEqual(loadRegistry(dir), []);
  });
});

describe("entriesForSession", () => {
  function entry(id: string, sessionId?: string): PrEntry {
    return {
      id,
      sessionId,
      prName: `pr ${id}`,
      branch: `pi/${id}`,
      base: "main",
      mode: "independent",
      paneId: "%1",
      worktree: "/tmp",
      depth: 1,
      parentId: "root",
      status: "working",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  test("returns only entries whose sessionId matches", () => {
    const entries = [entry("a", "s1"), entry("b", "s2"), entry("c", "s1")];
    assert.deepEqual(
      entriesForSession(entries, "s1").map((e) => e.id),
      ["a", "c"],
    );
  });

  test("returns [] when no entry matches the session", () => {
    const entries = [entry("a", "s1"), entry("b", "s2")];
    assert.deepEqual(entriesForSession(entries, "other"), []);
  });

  test("an undefined sessionId selects only legacy untagged entries", () => {
    const entries = [entry("a", "s1"), entry("legacy")];
    assert.deepEqual(
      entriesForSession(entries, undefined).map((e) => e.id),
      ["legacy"],
    );
  });

  test("does not mutate the input array", () => {
    const entries = [entry("a", "s1"), entry("b", "s2")];
    const snapshot = [...entries];
    entriesForSession(entries, "s1");
    assert.deepEqual(entries, snapshot);
    assert.equal(entries.length, 2);
  });
});

describe("resolveOrchestratorSessionId", () => {
  const fallback = () => "RANDOM";

  test("prefers the real pi session id over env and fallback", () => {
    assert.equal(resolveOrchestratorSessionId({ sessionId: "pi-sess", env: "env-sess", fallback }), "pi-sess");
  });

  test("falls back to PI_PR_SESSION env when there is no session id", () => {
    assert.equal(resolveOrchestratorSessionId({ sessionId: undefined, env: "env-sess", fallback }), "env-sess");
    assert.equal(resolveOrchestratorSessionId({ sessionId: "", env: "env-sess", fallback }), "env-sess");
    assert.equal(resolveOrchestratorSessionId({ sessionId: "   ", env: "env-sess", fallback }), "env-sess");
  });

  test("falls back to the random id only when neither session id nor env is set", () => {
    assert.equal(resolveOrchestratorSessionId({ sessionId: undefined, env: undefined, fallback }), "RANDOM");
    assert.equal(resolveOrchestratorSessionId({ sessionId: "", env: "  ", fallback }), "RANDOM");
  });

  test("trims whitespace around the resolved id", () => {
    assert.equal(resolveOrchestratorSessionId({ sessionId: "  pi-sess  ", env: undefined, fallback }), "pi-sess");
    assert.equal(resolveOrchestratorSessionId({ sessionId: undefined, env: "  env-sess  ", fallback }), "env-sess");
  });
});

describe("worktreesDirFrom", () => {
  test("nests .worktrees inside the repo root, not a sibling dir", () => {
    const root = "/a/b/repo";
    assert.equal(worktreesDirFrom(root), path.join(root, ".worktrees"));
  });
});

describe("project config round-trip", () => {
  // projectConfigPath resolves the repo root via `git rev-parse --show-toplevel`,
  // so operate inside a hermetic temp repo and scrub inherited GIT_* env vars
  // that could otherwise redirect git at a different repo (test-isolation bug).
  const GIT_ENV = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;
  let dir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of GIT_ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-agents-cfg-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
  });

  afterEach(() => {
    for (const k of GIT_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("projectConfigPath points at <repo-root>/.pi/pr-agents.json and creates .pi", () => {
    const p = projectConfigPath(dir);
    assert.equal(path.basename(p), "pr-agents.json");
    assert.equal(path.basename(path.dirname(p)), ".pi");
    assert.ok(fs.existsSync(path.dirname(p)), ".pi directory should be created");
  });

  test("loadProjectConfig returns {} when no config file exists", () => {
    assert.deepEqual(loadProjectConfig(dir), {});
  });

  test("saveProjectConfig writes and loadProjectConfig reads it back", () => {
    saveProjectConfig(dir, { strategy: "graphite" });
    assert.deepEqual(loadProjectConfig(dir), { strategy: "graphite" });
    const raw = JSON.parse(fs.readFileSync(projectConfigPath(dir), "utf8"));
    assert.deepEqual(raw, { strategy: "graphite" });
  });

  test("saveProjectConfig merges patches rather than overwriting the whole file", () => {
    saveProjectConfig(dir, { strategy: "github" });
    saveProjectConfig(dir, {});
    assert.deepEqual(loadProjectConfig(dir), { strategy: "github" });
    saveProjectConfig(dir, { strategy: "graphite" });
    assert.deepEqual(loadProjectConfig(dir), { strategy: "graphite" });
  });
});
