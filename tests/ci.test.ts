import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type CiCheck, type CiFailure, buildCiFixTask, selectNewCiFailures } from "../extensions/pr-agents.ts";

function check(patch: Partial<CiCheck> & { name: string }): CiCheck {
  return { state: "failure", bucket: "fail", link: "https://gh/run/1", ...patch };
}

describe("selectNewCiFailures", () => {
  test("filters to bucket==='fail' and keys ci:<sha>:<name>", () => {
    const checks: CiCheck[] = [
      check({ name: "typecheck", bucket: "fail", state: "failure" }),
      check({ name: "lint", bucket: "pass", state: "success" }),
      check({ name: "test", bucket: "pending", state: "in_progress" }),
      check({ name: "docs", bucket: "skipping", state: "skipped" }),
    ];
    const sel = selectNewCiFailures(checks, "abc123", new Set());
    assert.deepEqual(
      sel.failures.map((f) => f.name),
      ["typecheck"],
    );
    assert.deepEqual(sel.newKeys, ["ci:abc123:typecheck"]);
  });

  test("carries name/state/link onto each failure", () => {
    const checks: CiCheck[] = [check({ name: "build", state: "cancelled", bucket: "fail", link: "https://gh/run/9" })];
    const sel = selectNewCiFailures(checks, "sha", new Set());
    const f: CiFailure = sel.failures[0];
    assert.equal(f.name, "build");
    assert.equal(f.state, "cancelled");
    assert.equal(f.link, "https://gh/run/9");
  });

  test("excludes failures whose key is already seen", () => {
    const checks: CiCheck[] = [check({ name: "typecheck" }), check({ name: "test" })];
    const sel = selectNewCiFailures(checks, "sha1", new Set(["ci:sha1:typecheck"]));
    assert.deepEqual(
      sel.failures.map((f) => f.name),
      ["test"],
    );
    assert.deepEqual(sel.newKeys, ["ci:sha1:test"]);
  });

  test("a new head sha re-surfaces a still-failing check (per-commit dedup)", () => {
    const checks: CiCheck[] = [check({ name: "typecheck" })];
    // Same check failing, but the sha changed after a fix-push => new key.
    const seen = new Set(["ci:oldsha:typecheck"]);
    const sel = selectNewCiFailures(checks, "newsha", seen);
    assert.deepEqual(sel.newKeys, ["ci:newsha:typecheck"]);
    assert.equal(sel.failures.length, 1);
  });

  test("dedupes repeated names within one tick", () => {
    const checks: CiCheck[] = [check({ name: "test" }), check({ name: "test" })];
    const sel = selectNewCiFailures(checks, "sha", new Set());
    assert.deepEqual(sel.newKeys, ["ci:sha:test"]);
  });
});

describe("buildCiFixTask", () => {
  test("lists each failing check with name, state and link", () => {
    const msg = buildCiFixTask(
      [
        { name: "typecheck", state: "failure", link: "https://gh/run/1" },
        { name: "test", state: "timed_out", link: "https://gh/run/2" },
      ],
      42,
    );
    assert.match(msg, /CI is failing on PR #42/);
    assert.match(msg, /- typecheck \(failure\) https:\/\/gh\/run\/1/);
    assert.match(msg, /- test \(timed_out\) https:\/\/gh\/run\/2/);
  });

  test("omits the link suffix when absent", () => {
    const msg = buildCiFixTask([{ name: "lint", state: "failure", link: "" }], 1);
    assert.match(msg, /- lint \(failure\)$/m);
  });

  test("includes the local-gate fix instruction and the do-not-weaken rule", () => {
    const msg = buildCiFixTask([{ name: "test", state: "failure", link: "" }], 7);
    assert.match(msg, /npm run typecheck && npm run lint && npm test/);
    assert.match(msg, /gh run view --log-failed/);
    assert.match(msg, /Do not disable or weaken checks/);
  });
});
