import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type PendingStack,
  type PrEntry,
  STACK_SETTLE_MS,
  groupIntoStacks,
  selectSettledStacks,
  stackKey,
} from "../extensions/pr-agents.ts";

// Minimal depth-1 entry factory. `branch`/`base` drive stack linkage; the rest
// are defaults that keep groupIntoStacks deterministic (createdAt then id).
function mk(id: string, base: string, branch: string, over: Partial<PrEntry> = {}): PrEntry {
  return {
    id,
    prName: `pr ${id}`,
    branch,
    base,
    mode: "graphite",
    paneId: `%${id}`,
    worktree: `/wt/${id}`,
    depth: 1,
    parentId: "root",
    status: "open",
    createdAt: `2026-01-01T00:00:0${id.length}Z`,
    ...over,
  };
}

describe("groupIntoStacks", () => {
  test("a 3-PR base-chain returns one bottom→top ordered stack", () => {
    const a = mk("a", "main", "pi/a");
    const b = mk("b", "pi/a", "pi/b");
    const c = mk("c", "pi/b", "pi/c");
    const stacks = groupIntoStacks([c, a, b]);
    assert.equal(stacks.length, 1);
    assert.deepEqual(
      stacks[0].map((e) => e.id),
      ["a", "b", "c"],
    );
  });

  test("two independent PRs return two singleton stacks", () => {
    const x = mk("x", "main", "pi/x");
    const y = mk("y", "main", "pi/y");
    const stacks = groupIntoStacks([x, y]);
    assert.equal(stacks.length, 2);
    assert.ok(stacks.every((s) => s.length === 1));
  });

  test("a mix of one stack and one singleton groups correctly", () => {
    const a = mk("a", "main", "pi/a");
    const b = mk("b", "pi/a", "pi/b");
    const solo = mk("solo", "main", "pi/solo");
    const stacks = groupIntoStacks([b, solo, a]);
    assert.equal(stacks.length, 2);
    const byKey = new Map(stacks.map((s) => [stackKey(s), s]));
    assert.deepEqual(
      byKey.get("a")?.map((e) => e.id),
      ["a", "b"],
    );
    assert.deepEqual(
      byKey.get("solo")?.map((e) => e.id),
      ["solo"],
    );
  });

  test("ignores depth-2 (helper) entries", () => {
    const a = mk("a", "main", "pi/a");
    const helper = mk("h", "pi/a", "pi/h", { depth: 2 });
    const stacks = groupIntoStacks([a, helper]);
    assert.equal(stacks.length, 1);
    assert.deepEqual(
      stacks[0].map((e) => e.id),
      ["a"],
    );
  });

  test("a missing parent link yields a singleton (no infinite loop)", () => {
    // b's base points to a branch no registry entry owns.
    const b = mk("b", "pi/ghost", "pi/b");
    const stacks = groupIntoStacks([b]);
    assert.equal(stacks.length, 1);
    assert.deepEqual(
      stacks[0].map((e) => e.id),
      ["b"],
    );
  });

  test("a self/cyclic link does not infinite-loop", () => {
    // self link: base === own branch.
    const self = mk("self", "pi/self", "pi/self");
    // 2-cycle: p.base = q.branch and q.base = p.branch.
    const p = mk("p", "pi/q", "pi/p");
    const q = mk("q", "pi/p", "pi/q");
    const stacks = groupIntoStacks([self, p, q]);
    // Must terminate; every entry appears at most once per chain.
    for (const s of stacks) {
      assert.equal(new Set(s.map((e) => e.id)).size, s.length);
    }
    const ids = stacks.flat().map((e) => e.id);
    assert.ok(ids.includes("self"));
  });
});

describe("stackKey", () => {
  test("is stable for the same stack (bottom entry id)", () => {
    const a = mk("a", "main", "pi/a");
    const b = mk("b", "pi/a", "pi/b");
    const stack = groupIntoStacks([a, b])[0];
    assert.equal(stackKey(stack), "a");
    assert.equal(stackKey(stack), stackKey(stack));
  });
});

describe("selectSettledStacks", () => {
  const pend = (updatedAt: number): PendingStack => ({ transitions: [], updatedAt });

  test("returns only keys older than settleMs", () => {
    const now = 100_000;
    const pending = new Map<string, PendingStack>([
      ["old", pend(now - STACK_SETTLE_MS - 1)],
      ["fresh", pend(now - 1000)],
    ]);
    assert.deepEqual(selectSettledStacks(pending, now, STACK_SETTLE_MS), ["old"]);
  });

  test("a freshly-updated stack (updatedAt = now) is NOT returned", () => {
    const now = 100_000;
    const pending = new Map<string, PendingStack>([["s", pend(now)]]);
    assert.deepEqual(selectSettledStacks(pending, now, STACK_SETTLE_MS), []);
  });

  test("a stack exactly at the settle boundary IS returned", () => {
    const now = 100_000;
    const pending = new Map<string, PendingStack>([["s", pend(now - STACK_SETTLE_MS)]]);
    assert.deepEqual(selectSettledStacks(pending, now, STACK_SETTLE_MS), ["s"]);
  });

  test("handles multiple stacks", () => {
    const now = 100_000;
    const pending = new Map<string, PendingStack>([
      ["a", pend(now - STACK_SETTLE_MS - 5)],
      ["b", pend(now - STACK_SETTLE_MS - 5)],
      ["c", pend(now)],
    ]);
    assert.deepEqual(selectSettledStacks(pending, now, STACK_SETTLE_MS).sort(), ["a", "b"]);
  });
});
