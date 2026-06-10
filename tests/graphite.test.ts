import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type GraphitePrInfo, classifyGraphitePrState, parseGraphitePrInfos } from "../extensions/pr-agents.ts";

describe("parseGraphitePrInfos", () => {
  test("extracts number/branch/state/title/url from a representative prInfos array", () => {
    const json = {
      prInfos: [
        {
          prNumber: 101,
          branchName: "pi/feature-a",
          state: "OPEN",
          title: "Add feature A",
          url: "https://github.com/o/r/pull/101",
        },
      ],
    };
    const infos = parseGraphitePrInfos(json);
    assert.deepEqual(infos, [
      {
        prNumber: 101,
        branch: "pi/feature-a",
        state: "OPEN",
        title: "Add feature A",
        url: "https://github.com/o/r/pull/101",
      } satisfies GraphitePrInfo,
    ]);
  });

  test("handles the `number` spelling for the PR number", () => {
    const infos = parseGraphitePrInfos({ prInfos: [{ number: 7, branchName: "b" }] });
    assert.equal(infos.length, 1);
    assert.equal(infos[0].prNumber, 7);
    assert.equal(infos[0].branch, "b");
  });

  test("prefers prNumber over number when both present", () => {
    const infos = parseGraphitePrInfos({ prInfos: [{ prNumber: 5, number: 9 }] });
    assert.equal(infos[0].prNumber, 5);
  });

  test("resolves the branch from headRefName when branchName is absent", () => {
    const infos = parseGraphitePrInfos({ prInfos: [{ number: 1, headRefName: "head-ref" }] });
    assert.equal(infos[0].branch, "head-ref");
  });

  test("resolves the branch from `branch` as a last resort", () => {
    const infos = parseGraphitePrInfos({ prInfos: [{ number: 1, branch: "plain-branch" }] });
    assert.equal(infos[0].branch, "plain-branch");
  });

  test("defaults missing string fields to empty strings", () => {
    const infos = parseGraphitePrInfos({ prInfos: [{ prNumber: 2 }] });
    assert.deepEqual(infos, [{ prNumber: 2, branch: "", state: "", title: "", url: "" }]);
  });

  test("skips null/garbage entries and entries with no resolvable number", () => {
    const infos = parseGraphitePrInfos({
      prInfos: [null, 42, "nope", { branchName: "no-number" }, { prNumber: 3, branchName: "ok" }],
    });
    assert.deepEqual(
      infos.map((i) => i.prNumber),
      [3],
    );
  });

  test("ignores a non-numeric prNumber", () => {
    const infos = parseGraphitePrInfos({ prInfos: [{ prNumber: "12", branchName: "x" }] });
    assert.deepEqual(infos, []);
  });

  test("returns [] for null/non-object/missing-prInfos input", () => {
    assert.deepEqual(parseGraphitePrInfos(null), []);
    assert.deepEqual(parseGraphitePrInfos(undefined), []);
    assert.deepEqual(parseGraphitePrInfos(42), []);
    assert.deepEqual(parseGraphitePrInfos("nope"), []);
    assert.deepEqual(parseGraphitePrInfos({}), []);
    assert.deepEqual(parseGraphitePrInfos({ prInfos: null }), []);
    assert.deepEqual(parseGraphitePrInfos({ prInfos: "not-an-array" }), []);
  });
});

describe("classifyGraphitePrState", () => {
  test("maps MERGED/CLOSED/OPEN (uppercase) correctly", () => {
    assert.equal(classifyGraphitePrState({ state: "MERGED" }), "merged");
    assert.equal(classifyGraphitePrState({ state: "CLOSED" }), "closed");
    assert.equal(classifyGraphitePrState({ state: "OPEN" }), "open");
  });

  test("is case-insensitive", () => {
    assert.equal(classifyGraphitePrState({ state: "merged" }), "merged");
    assert.equal(classifyGraphitePrState({ state: "Closed" }), "closed");
    assert.equal(classifyGraphitePrState({ state: "open" }), "open");
  });

  test("maps unknown/empty states to 'unknown'", () => {
    assert.equal(classifyGraphitePrState({ state: "DRAFT" }), "unknown");
    assert.equal(classifyGraphitePrState({ state: "" }), "unknown");
  });
});
