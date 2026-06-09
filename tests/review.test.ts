import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type FetchedReviewActivity,
  type InlineComment,
  buildReviewTask,
  selectNewReviewItems,
} from "../extensions/pr-agents.ts";

function inline(patch: Partial<InlineComment> & { id: number }): InlineComment {
  return {
    user: "alice",
    body: "please fix",
    path: "src/a.ts",
    line: 12,
    createdAt: "2026-01-01T00:00:00Z",
    inReplyToId: null,
    ...patch,
  };
}

function activity(patch: Partial<FetchedReviewActivity> = {}): FetchedReviewActivity {
  return { inline: [], reviews: [], issueComments: [], ...patch };
}

describe("selectNewReviewItems", () => {
  test("new inline comments are actionable and keyed rc:<id>", () => {
    const fetched = activity({ inline: [inline({ id: 1 }), inline({ id: 2 })] });
    const sel = selectNewReviewItems(fetched, new Set());
    assert.deepEqual(
      sel.actionable.map((c) => c.id),
      [1, 2],
    );
    assert.deepEqual(sel.newIds, ["rc:1", "rc:2"]);
    assert.deepEqual(sel.contextNotes, []);
  });

  test("inline comments already in the seen-set are skipped (loop prevention)", () => {
    const fetched = activity({ inline: [inline({ id: 1 }), inline({ id: 2 })] });
    const sel = selectNewReviewItems(fetched, new Set(["rc:1"]));
    assert.deepEqual(
      sel.actionable.map((c) => c.id),
      [2],
    );
    assert.deepEqual(sel.newIds, ["rc:2"]);
  });

  test("review summaries (COMMENTED/CHANGES_REQUESTED, non-empty body) become context with distinct rv: keys", () => {
    const fetched = activity({
      reviews: [
        { id: 9, author: "bob", body: "looks risky", state: "CHANGES_REQUESTED", submittedAt: "t1" },
        { id: 10, author: "bob", body: "", state: "COMMENTED", submittedAt: "t2" }, // empty => skipped
        { id: 11, author: "bob", body: "approved", state: "APPROVED", submittedAt: "t3" }, // state => skipped
      ],
    });
    const sel = selectNewReviewItems(fetched, new Set());
    assert.deepEqual(sel.actionable, []);
    assert.equal(sel.contextNotes.length, 1);
    assert.match(sel.contextNotes[0], /review by bob \(CHANGES_REQUESTED\): looks risky/);
    assert.deepEqual(sel.newIds, ["rv:9"]);
  });

  test("issue comments become context with ic: keys, falling back to createdAt+author when id missing", () => {
    const fetched = activity({
      issueComments: [{ author: "carol", body: "nit", createdAt: "2026-02-02T00:00:00Z" }],
    });
    const sel = selectNewReviewItems(fetched, new Set());
    assert.deepEqual(sel.actionable, []);
    assert.match(sel.contextNotes[0], /comment by carol: nit/);
    assert.deepEqual(sel.newIds, ["ic:2026-02-02T00:00:00Z+carol"]);
  });

  test("the three id kinds never collide and seen entries of any kind are honored", () => {
    const fetched = activity({
      inline: [inline({ id: 5 })],
      reviews: [{ id: 5, author: "bob", body: "ctx", state: "COMMENTED", submittedAt: "t" }],
      issueComments: [{ id: 5, author: "carol", body: "ctx2", createdAt: "t" }],
    });
    // rc:5 already seen; rv:5 and ic:5 are still new (distinct namespaces).
    const sel = selectNewReviewItems(fetched, new Set(["rc:5"]));
    assert.deepEqual(sel.actionable, []);
    assert.deepEqual(sel.newIds, ["rv:5", "ic:5"]);
  });
});

describe("buildReviewTask", () => {
  test("formats each inline comment with id, path and line", () => {
    const msg = buildReviewTask([inline({ id: 7, path: "src/x.ts", line: 33, body: "rename this" })], [], 42);
    assert.match(msg, /PR #42/);
    assert.match(msg, /- \[rc:7\] src\/x\.ts:33 — rename this/);
  });

  test("uses path only when the line is null", () => {
    const msg = buildReviewTask([inline({ id: 8, path: "src/y.ts", line: null })], [], 1);
    assert.match(msg, /- \[rc:8\] src\/y\.ts —/);
  });

  test("includes context notes when present", () => {
    const msg = buildReviewTask([inline({ id: 1 })], ["review by bob (CHANGES_REQUESTED): big concern"], 3);
    assert.match(msg, /Additional context:/);
    assert.match(msg, /big concern/);
  });

  test("includes the no-resolve + reply-tool instructions", () => {
    const msg = buildReviewTask([inline({ id: 1 })], [], 3);
    assert.match(msg, /reply_to_review_comment/);
    assert.match(msg, /Do NOT resolve threads/);
    assert.match(msg, /npm run typecheck && npm run lint && npm test/);
  });
});
