import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  aliasBlock,
  detectShell,
  findEntry,
  loadRegistry,
  paneTitle,
  type PrEntry,
  saveRegistry,
  shq,
  slugify,
  updateEntry,
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
    assert.equal(
      paneTitle({ prNumber: 42, prName: "add tests", branch: "pi/tests" }),
      "PR#42 add tests (pi/tests)",
    );
  });

  test("omits the number when prNumber is undefined", () => {
    assert.equal(
      paneTitle({ prNumber: undefined, prName: "add tests", branch: "pi/tests" }),
      "PR add tests (pi/tests)",
    );
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
    assert.ok(block.includes("function pi --wraps pi"));
    assert.ok(block.includes(BEGIN));
    assert.ok(block.includes(END));
  });

  for (const kind of ["zsh", "bash"] as const) {
    test(`${kind} block defines a pi() function and markers`, () => {
      const block = aliasBlock(kind);
      assert.ok(block.includes("pi() {"));
      assert.ok(block.includes(BEGIN));
      assert.ok(block.includes(END));
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

describe("registry round-trip", () => {
  let dir: string;

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-agents-test-"));
    // registryPath derives its dir from gitCommonDir(cwd), which shells out to
    // git, so initialise a real (empty, quiet) repo to keep the test hermetic.
    execFileSync("git", ["init", "-q"], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
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
