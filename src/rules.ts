import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import type { Rule } from "./types.ts";

const loginSchema = z.string().min(1).regex(/^[^@]+$/);

const ruleSchema = z.strictObject({
  base: z.string().min(1),
  upstream: z.string().regex(/^[^:\s]+:[^:\s]+$/),
  mergeMethod: z.enum(["none", "merge", "squash", "rebase", "hardreset"])
    .default("none"),
  autoMerge: z.boolean().default(false),
  mergeUnstable: z.boolean().default(false),
  label: z.string().min(1).default("upstream-sync"),
  conflictLabel: z.string().min(1).default("merge-conflict"),
  assignees: z.array(loginSchema).default([]),
  reviewers: z.array(loginSchema).default([]),
  conflictReviewers: z.array(loginSchema).default([]),
}).superRefine((rule, context) => {
  if (rule.autoMerge && rule.mergeMethod === "none") {
    context.addIssue({
      code: "custom",
      message: "autoMerge requires a mergeMethod",
    });
  }
});

const configSchema = z.strictObject({
  version: z.literal("1"),
  rules: z.array(ruleSchema),
});

const documentSchema = z.strictObject({
  version: z.literal("1"),
  rules: z.array(z.unknown()),
});

export interface IndexedRule {
  index: number;
  rule: Rule;
}

export interface RuleIssue {
  index: number;
}

export interface RulesDocument {
  rules: IndexedRule[];
  issues: RuleIssue[];
}

export function parseRules(yaml: string): Rule[] {
  return configSchema.parse(parseYaml(yaml)).rules;
}

export function parseRulesDocument(yaml: string): RulesDocument {
  const document = documentSchema.parse(parseYaml(yaml));
  const rules: IndexedRule[] = [];
  const issues: RuleIssue[] = [];

  for (const [index, value] of document.rules.entries()) {
    const result = ruleSchema.safeParse(value);
    if (result.success) {
      rules.push({ index, rule: result.data });
    } else {
      issues.push({ index });
    }
  }

  return { rules, issues };
}
