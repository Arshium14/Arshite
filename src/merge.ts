import type { Rule } from "./types.ts";

export interface MergePullRequest {
  state: string;
  draft: boolean;
  mergeable_state: string;
  head: { label: string; sha: string };
  base: { ref: string };
}

export function canMerge(pr: MergePullRequest, rule: Rule): boolean {
  if (!rule.autoMerge) return false;
  if (!["merge", "squash", "rebase"].includes(rule.mergeMethod)) return false;
  if (pr.state !== "open" || pr.draft) return false;
  if (pr.head.label !== rule.upstream || pr.base.ref !== rule.base) {
    return false;
  }

  return pr.mergeable_state === "clean" ||
    (pr.mergeable_state === "unstable" && rule.mergeUnstable);
}
