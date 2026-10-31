import { assertEquals } from "@std/assert";
import { canMerge } from "../src/merge.ts";
import type { Rule } from "../src/types.ts";

const rule: Rule = {
  base: "main",
  upstream: "org:main",
  mergeMethod: "merge",
  autoMerge: true,
  mergeUnstable: false,
  label: "upstream-sync",
  conflictLabel: "merge-conflict",
  assignees: [],
  reviewers: [],
  conflictReviewers: [],
};

const openPr = {
  state: "open",
  draft: false,
  mergeable_state: "clean",
  head: { label: "org:main", sha: "upstream-head-sha" },
  base: { ref: "main" },
};

Deno.test("merge guard accepts clean only with explicit opt-in", () => {
  assertEquals(canMerge(openPr, { ...rule, autoMerge: false }), false);
  assertEquals(canMerge(openPr, { ...rule, mergeMethod: "merge" }), true);
});

Deno.test("merge guard accepts squash and rebase methods", () => {
  assertEquals(canMerge(openPr, { ...rule, mergeMethod: "squash" }), true);
  assertEquals(canMerge(openPr, { ...rule, mergeMethod: "rebase" }), true);
});

Deno.test("merge guard rejects blocked, dirty, behind, and unknown PRs", () => {
  for (const mergeableState of ["blocked", "dirty", "behind", "unknown"]) {
    assertEquals(
      canMerge({ ...openPr, mergeable_state: mergeableState }, rule),
      false,
    );
  }
});

Deno.test("merge guard rejects draft and mismatched head or base PRs", () => {
  assertEquals(canMerge({ ...openPr, draft: true }, rule), false);
  assertEquals(
    canMerge({
      ...openPr,
      head: { label: "other:main", sha: "other-head-sha" },
    }, rule),
    false,
  );
  assertEquals(
    canMerge({ ...openPr, base: { ref: "release" } }, rule),
    false,
  );
});

Deno.test("merge guard requires explicit opt-in for unstable PRs", () => {
  const unstablePr = { ...openPr, mergeable_state: "unstable" };

  assertEquals(canMerge(unstablePr, rule), false);
  assertEquals(canMerge(unstablePr, { ...rule, mergeUnstable: true }), true);
});

Deno.test("merge guard rejects hardreset and none merge methods", () => {
  assertEquals(canMerge(openPr, { ...rule, mergeMethod: "hardreset" }), false);
  assertEquals(canMerge(openPr, { ...rule, mergeMethod: "none" }), false);
});

Deno.test("merge guard rejects closed PRs", () => {
  assertEquals(canMerge({ ...openPr, state: "closed" }, rule), false);
});
