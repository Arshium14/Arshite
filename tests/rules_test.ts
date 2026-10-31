import { assertEquals, assertThrows } from "@std/assert";
import { parseRules, parseRulesDocument } from "../src/rules.ts";

Deno.test("parseRules applies safe defaults", () => {
  const [rule] = parseRules(
    `version: "1"\nrules:\n  - base: main\n    upstream: org:main\n`,
  );

  assertEquals(rule, {
    base: "main",
    upstream: "org:main",
    mergeMethod: "none",
    autoMerge: false,
    mergeUnstable: false,
    label: "upstream-sync",
    conflictLabel: "merge-conflict",
    assignees: [],
    reviewers: [],
    conflictReviewers: [],
  });
});

Deno.test("parseRules accepts every valid merge method", () => {
  for (
    const mergeMethod of ["none", "merge", "squash", "rebase", "hardreset"]
  ) {
    const [rule] = parseRules(
      `version: "1"\nrules:\n  - base: main\n    upstream: org:main\n    mergeMethod: ${mergeMethod}\n`,
    );
    assertEquals(rule.mergeMethod, mergeMethod);
  }
});

Deno.test("parseRules preserves explicit rule settings", () => {
  const [rule] = parseRules(
    `version: "1"\nrules:\n  - base: release\n    upstream: upstream:main\n    mergeMethod: squash\n    autoMerge: true\n    mergeUnstable: true\n    label: sync\n    conflictLabel: conflict\n    assignees: [alice]\n    reviewers: [bob]\n    conflictReviewers: [carol]\n`,
  );

  assertEquals(rule, {
    base: "release",
    upstream: "upstream:main",
    mergeMethod: "squash",
    autoMerge: true,
    mergeUnstable: true,
    label: "sync",
    conflictLabel: "conflict",
    assignees: ["alice"],
    reviewers: ["bob"],
    conflictReviewers: ["carol"],
  });
});

Deno.test("parseRules rejects unknown safety settings", () => {
  assertThrows(() =>
    parseRules(
      `version: "1"\nrules:\n  - base: main\n    upstream: org:main\n    automerge: true\n`,
    )
  );
});

Deno.test("parseRules rejects unknown config keys", () => {
  assertThrows(() =>
    parseRules(
      `version: "1"\nunknown: true\nrules:\n  - base: main\n    upstream: org:main\n`,
    )
  );
});

Deno.test("parseRules rejects missing base or upstream", () => {
  const configs = [
    `version: "1"\nrules:\n  - upstream: org:main\n`,
    `version: "1"\nrules:\n  - base: main\n`,
  ];

  for (const config of configs) {
    assertThrows(() => parseRules(config));
  }
});

Deno.test("parseRules rejects malformed upstream references", () => {
  for (const upstream of ["org", "org:", ":main", "org:main:extra", ""]) {
    assertThrows(() =>
      parseRules(
        `version: "1"\nrules:\n  - base: main\n    upstream: ${
          JSON.stringify(upstream)
        }\n`,
      )
    );
  }
});

Deno.test("parseRules rejects auto-merge without a merge method", () => {
  assertThrows(() =>
    parseRules(
      `version: "1"\nrules:\n  - base: main\n    upstream: org:main\n    autoMerge: true\n`,
    )
  );
  assertThrows(() =>
    parseRules(
      `version: "1"\nrules:\n  - base: main\n    upstream: org:main\n    autoMerge: true\n    mergeMethod: none\n`,
    )
  );
});

Deno.test("parseRules requires version to be the string 1", () => {
  for (const version of ["1", "2"]) {
    assertThrows(() =>
      parseRules(
        `version: ${version}\nrules:\n  - base: main\n    upstream: org:main\n`,
      )
    );
  }
});

Deno.test("parseRulesDocument isolates invalid entries and preserves valid rule indexes", () => {
  const document = parseRulesDocument(
    `version: "1"\nrules:\n  - base: main\n    upstream: org:main\n  - base: release\n    upstream: invalid\n    credential: secret\n  - base: develop\n    upstream: upstream:main\n    autoMerge: true\n    mergeMethod: squash\n`,
  );

  assertEquals(document.rules.map(({ index }) => index), [0, 2]);
  assertEquals(document.rules.map(({ rule }) => rule.base), [
    "main",
    "develop",
  ]);
  assertEquals(document.issues, [{ index: 1 }]);
  assertEquals(JSON.stringify(document).includes("secret"), false);
});

Deno.test("parseRulesDocument rejects malformed top-level configuration", () => {
  for (
    const config of [
      `version: "2"\nrules: []\n`,
      `version: "1"\nrules: invalid\n`,
      `version: "1"\nunknown: true\nrules: []\n`,
    ]
  ) {
    assertThrows(() => parseRulesDocument(config));
  }
});

Deno.test("parseRules rejects login entries containing @", () => {
  for (
    const field of ["assignees", "reviewers", "conflictReviewers"]
  ) {
    assertThrows(() =>
      parseRules(
        `version: "1"\nrules:\n  - base: main\n    upstream: org:main\n    ${field}: ["@alice"]\n`,
      )
    );
  }
});
