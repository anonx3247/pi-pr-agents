import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type ChangedFile, buildSimplifyPrompt, parseChangedFiles } from "../extensions/pr-agents.ts";

describe("parseChangedFiles", () => {
  test("maps M/A status codes to modified/added", () => {
    const out = "M\tsrc/a.ts\nA\tsrc/b.ts";
    assert.deepEqual(parseChangedFiles(out), [
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "added" },
    ]);
  });

  test("renamed (R) uses the NEW path (3rd tab field)", () => {
    const out = "R100\told/name.ts\tnew/name.ts";
    assert.deepEqual(parseChangedFiles(out), [{ path: "new/name.ts", status: "renamed" }]);
  });

  test("copied (C) uses the NEW path (3rd tab field)", () => {
    const out = "C75\tsrc/orig.ts\tsrc/copy.ts";
    assert.deepEqual(parseChangedFiles(out), [{ path: "src/copy.ts", status: "copied" }]);
  });

  test("skips blank lines and unknown status codes", () => {
    const out = "\nM\tsrc/a.ts\n\nD\tsrc/gone.ts\n   \nA\tsrc/b.ts\n";
    assert.deepEqual(parseChangedFiles(out), [
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "added" },
    ]);
  });

  test("returns empty array for empty input", () => {
    assert.deepEqual(parseChangedFiles(""), []);
  });
});

describe("buildSimplifyPrompt", () => {
  const files: ChangedFile[] = [
    { path: "src/a.ts", status: "modified" },
    { path: "src/b.ts", status: "added" },
    { path: "src/c.ts", status: "renamed" },
  ];

  test("lists each file as `- path (status)`", () => {
    const prompt = buildSimplifyPrompt(files);
    assert.match(prompt, /- src\/a\.ts \(modified\)/);
    assert.match(prompt, /- src\/b\.ts \(added\)/);
    assert.match(prompt, /- src\/c\.ts \(renamed\)/);
  });

  test("contains the Principles / Scope / Process headers", () => {
    const prompt = buildSimplifyPrompt(files);
    assert.match(prompt, /## Principles/);
    assert.match(prompt, /## Scope/);
    assert.match(prompt, /## Process/);
  });

  test("appends the refactor-commit continuation instruction", () => {
    const prompt = buildSimplifyPrompt(files);
    assert.match(prompt, /atomic `refactor: simplify` commit/);
    assert.match(prompt, /apply the changes now, in this turn/);
  });
});
