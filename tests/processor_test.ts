import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  ConfigurationError,
  processRepository,
  processRule,
} from "../src/processor.ts";
import type { GitHubClient, RepositoryRecord, Rule } from "../src/types.ts";

type Parameters = Record<string, unknown>;
type Handler = (parameters: Parameters) => unknown | Promise<unknown>;

interface Call {
  route: string;
  parameters?: Parameters;
}

class MockGitHubClient implements GitHubClient {
  readonly calls: Call[] = [];
  private readonly handlers = new Map<string, Handler>();

  on(route: string, handler: Handler): void {
    this.handlers.set(route, handler);
  }

  async request<T>(
    route: string,
    parameters: Parameters = {},
  ): Promise<{ data: T }> {
    this.calls.push({ route, parameters });
    const handler = this.handlers.get(route);
    if (!handler) throw new Error(`Unexpected GitHub route: ${route}`);
    return { data: await handler(parameters) as T };
  }

  get mutations(): Call[] {
    return this.calls.filter((call) => !call.route.startsWith("GET "));
  }
}

const repository: RepositoryRecord = {
  id: 1,
  installationId: 10,
  owner: "octocat",
  repo: "example",
  defaultBranch: "main",
  suspended: false,
};

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    base: "main",
    upstream: "upstream:main",
    mergeMethod: "none",
    autoMerge: false,
    mergeUnstable: false,
    label: "upstream-sync",
    conflictLabel: "merge-conflict",
    assignees: [],
    reviewers: [],
    conflictReviewers: [],
    ...overrides,
  };
}

interface TestPullRequest {
  number: number;
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { label: string; sha: string };
  base: { ref: string };
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  requested_reviewers: Array<{ login: string }>;
}

function makePull(
  overrides: Partial<TestPullRequest> = {},
): TestPullRequest {
  return {
    number: 7,
    state: "open",
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { label: "upstream:main", sha: "upstream-head-sha" },
    base: { ref: "main" },
    labels: [{ name: "upstream-sync" }],
    assignees: [],
    requested_reviewers: [],
    ...overrides,
  };
}

const compareRoute = "GET /repos/{owner}/{repo}/compare/{basehead}";
const listPullsRoute = "GET /repos/{owner}/{repo}/pulls";
const createPullRoute = "POST /repos/{owner}/{repo}/pulls";
const getPullRoute = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
const mergeRoute = "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge";
const labelsRoute = "POST /repos/{owner}/{repo}/issues/{issue_number}/labels";
const deleteLabelRoute =
  "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}";
const assigneesRoute =
  "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees";
const reviewersRoute =
  "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers";
const resetRoute = "PATCH /repos/{owner}/{repo}/git/refs/heads/{ref}";
const contentsRoute = "GET /repos/{owner}/{repo}/contents/{path}";
const repositoryRoute = "GET /repos/{owner}/{repo}";
const upstreamRefRoute = "GET /repos/{owner}/{repo}/git/ref/heads/{ref}";

function mockCompare(mock: MockGitHubClient, headSha = "upstream-sha"): void {
  mock.on(compareRoute, (parameters) => {
    assertEquals(parameters.basehead, "main...upstream:main");
    return { ahead_by: 1, commits: [{ sha: headSha }] };
  });
}

function mockExistingPull(
  mock: MockGitHubClient,
  pull: TestPullRequest | (() => TestPullRequest),
): void {
  mock.on(listPullsRoute, (parameters) => {
    assertEquals(parameters.state, "open");
    assertEquals(parameters.head, "upstream:main");
    assertEquals(parameters.base, "main");
    return [typeof pull === "function" ? pull() : pull];
  });
  mock.on(getPullRoute, () => typeof pull === "function" ? pull() : pull);
}

Deno.test("processRule performs no mutation when compare ahead_by is zero", async () => {
  const mock = new MockGitHubClient();
  mock.on(compareRoute, () => ({ ahead_by: 0, commits: [] }));

  await processRule(repository, makeRule(), mock);

  assertEquals(mock.calls.map((call) => call.route), [compareRoute]);
  assertEquals(mock.mutations, []);
});

Deno.test("processRule reuses an existing matching pull request", async () => {
  const mock = new MockGitHubClient();
  mockCompare(mock);
  mockExistingPull(mock, makePull({ number: 17 }));

  await processRule(repository, makeRule(), mock);

  assertEquals(
    mock.calls.some((call) => call.route === createPullRoute),
    false,
  );
  assertEquals(
    mock.calls.filter((call) => call.route === getPullRoute).length,
    1,
  );
  assertEquals(mock.calls[1].parameters?.pull_number, undefined);
  assertEquals(mock.calls[2].parameters?.pull_number, 17);
});

Deno.test("processRule creates a cross-repository pull request with authoritative head metadata", async () => {
  const mock = new MockGitHubClient();
  mockCompare(mock);
  mock.on(listPullsRoute, () => []);
  mock.on(repositoryRoute, () => ({
    name: "example",
    owner: { login: "octocat" },
    parent: { name: "original", owner: { login: "upstream" } },
    source: { name: "original", owner: { login: "upstream" } },
  }));
  mock.on(createPullRoute, () => makePull({ number: 23 }));
  mock.on(getPullRoute, (parameters) => {
    assertEquals(parameters.pull_number, 23);
    return makePull({ number: 23 });
  });

  await processRule(repository, makeRule(), mock);

  const creation = mock.calls.find((call) => call.route === createPullRoute);
  assertEquals(creation?.parameters?.owner, "octocat");
  assertEquals(creation?.parameters?.repo, "example");
  assertEquals(creation?.parameters?.title, "Sync upstream:main into main");
  assertEquals(creation?.parameters?.head, "upstream:main");
  assertEquals(creation?.parameters?.base, "main");
  assertEquals(creation?.parameters?.head_repo, "original");
  assertStringIncludes(String(creation?.parameters?.body), "upstream:main");
  assertStringIncludes(String(creation?.parameters?.body), "Source rule");
  assertEquals(
    mock.calls.findIndex((call) => call.route === createPullRoute) <
      mock.calls.findIndex((call) => call.route === getPullRoute),
    true,
  );
});

Deno.test("processRule supplies the current repository name for same-organization upstreams", async () => {
  const mock = new MockGitHubClient();
  mock.on(compareRoute, () => ({
    ahead_by: 1,
    commits: [{ sha: "same-org-upstream-sha" }],
  }));
  mock.on(listPullsRoute, () => []);
  mock.on(repositoryRoute, () => ({
    name: "example",
    owner: { login: "octocat" },
    parent: null,
    source: null,
  }));
  mock.on(createPullRoute, () =>
    makePull({
      number: 24,
      head: { label: "octocat:main", sha: "same-org-upstream-sha" },
    }));
  mock.on(getPullRoute, () =>
    makePull({
      number: 24,
      head: { label: "octocat:main", sha: "same-org-upstream-sha" },
    }));

  await processRule(
    repository,
    makeRule({ upstream: "octocat:main" }),
    mock,
  );

  const creation = mock.calls.find((call) => call.route === createPullRoute);
  assertEquals(creation?.parameters?.head, "octocat:main");
  assertEquals(creation?.parameters?.head_repo, "example");
});

Deno.test("processRule prefers the direct parent for same-organization forks", async () => {
  const mock = new MockGitHubClient();
  mock.on(compareRoute, () => ({
    ahead_by: 1,
    commits: [{ sha: "same-org-upstream-sha" }],
  }));
  mock.on(listPullsRoute, () => []);
  mock.on(repositoryRoute, () => ({
    name: "local-fork",
    owner: { login: "octocat" },
    parent: { name: "direct-parent", owner: { login: "octocat" } },
    source: { name: "original-source", owner: { login: "octocat" } },
  }));
  mock.on(createPullRoute, () => makePull({ number: 25 }));
  mock.on(getPullRoute, () => makePull({ number: 25 }));

  await processRule(
    repository,
    makeRule({ upstream: "octocat:main" }),
    mock,
  );

  const creation = mock.calls.find((call) => call.route === createPullRoute);
  assertEquals(creation?.parameters?.head_repo, "direct-parent");
});

Deno.test("processRule adds labels and only missing assignees and reviewers", async () => {
  const mock = new MockGitHubClient();
  const pull = makePull({
    labels: [],
    assignees: [{ login: "alice" }],
    requested_reviewers: [{ login: "carol" }],
  });
  mockCompare(mock);
  mockExistingPull(mock, pull);
  mock.on(labelsRoute, () => []);
  mock.on(assigneesRoute, () => ({}));
  mock.on(reviewersRoute, () => ({}));

  await processRule(
    repository,
    makeRule({
      assignees: ["alice", "bob"],
      reviewers: ["carol", "dave"],
    }),
    mock,
  );

  assertEquals(
    mock.calls.find((call) => call.route === labelsRoute)?.parameters,
    {
      owner: "octocat",
      repo: "example",
      issue_number: 7,
      labels: ["upstream-sync"],
    },
  );
  assertEquals(
    mock.calls.find((call) => call.route === assigneesRoute)?.parameters
      ?.assignees,
    ["bob"],
  );
  assertEquals(
    mock.calls.find((call) => call.route === reviewersRoute)?.parameters
      ?.reviewers,
    ["dave"],
  );
});

Deno.test("conflict automation is additive and cleanup removes only the conflict label", async () => {
  const mock = new MockGitHubClient();
  let current = makePull({
    mergeable: false,
    mergeable_state: "dirty",
    labels: [{ name: "upstream-sync" }, { name: "unrelated" }],
    requested_reviewers: [{ login: "regular" }],
  });
  mockCompare(mock);
  mockExistingPull(mock, () => current);
  mock.on(labelsRoute, (parameters) => {
    for (const name of parameters.labels as string[]) {
      current.labels.push({ name });
    }
    return [];
  });
  mock.on(reviewersRoute, (parameters) => {
    for (const login of parameters.reviewers as string[]) {
      current.requested_reviewers.push({ login });
    }
    return {};
  });
  mock.on(deleteLabelRoute, (parameters) => {
    assertEquals(parameters.name, "merge-conflict");
    current.labels = current.labels.filter((label) =>
      label.name !== parameters.name
    );
    return {};
  });
  const rule = makeRule({
    reviewers: ["regular"],
    conflictReviewers: ["conflict-reviewer"],
  });

  await processRule(repository, rule, mock);
  assertEquals(current.labels.map((label) => label.name), [
    "upstream-sync",
    "unrelated",
    "merge-conflict",
  ]);
  assertEquals(current.requested_reviewers.map((reviewer) => reviewer.login), [
    "regular",
    "conflict-reviewer",
  ]);

  current = {
    ...current,
    mergeable: true,
    mergeable_state: "clean",
  };
  await processRule(repository, rule, mock);

  assertEquals(current.labels.map((label) => label.name), [
    "upstream-sync",
    "unrelated",
  ]);
  assertEquals(current.requested_reviewers.map((reviewer) => reviewer.login), [
    "regular",
    "conflict-reviewer",
  ]);
  assertEquals(
    mock.calls.filter((call) => call.route === deleteLabelRoute).length,
    1,
  );
});

Deno.test("unknown mergeability leaves an existing conflict label unchanged", async () => {
  for (
    const pull of [
      makePull({
        mergeable: null,
        mergeable_state: "clean",
        labels: [{ name: "upstream-sync" }, { name: "merge-conflict" }],
      }),
      makePull({
        mergeable: true,
        mergeable_state: "unknown",
        labels: [{ name: "upstream-sync" }, { name: "merge-conflict" }],
      }),
    ]
  ) {
    const mock = new MockGitHubClient();
    mockCompare(mock);
    mockExistingPull(mock, pull);
    mock.on(deleteLabelRoute, () => ({}));

    await processRule(repository, makeRule(), mock);

    assertEquals(
      mock.calls.some((call) => call.route === deleteLabelRoute),
      false,
    );
  }
});

Deno.test("identical normal and conflict labels remain applied idempotently", async () => {
  const mock = new MockGitHubClient();
  const current = makePull({ labels: [] });
  mockCompare(mock);
  mockExistingPull(mock, current);
  mock.on(labelsRoute, (parameters) => {
    for (const name of parameters.labels as string[]) {
      current.labels.push({ name });
    }
    return [];
  });
  mock.on(deleteLabelRoute, (parameters) => {
    current.labels = current.labels.filter((label) =>
      label.name !== parameters.name
    );
    return {};
  });
  const rule = makeRule({ label: "sync", conflictLabel: "sync" });

  await processRule(repository, rule, mock);
  await processRule(repository, rule, mock);

  assertEquals(current.labels, [{ name: "sync" }]);
  assertEquals(
    mock.calls.filter((call) => call.route === labelsRoute).length,
    1,
  );
  assertEquals(
    mock.calls.filter((call) => call.route === deleteLabelRoute).length,
    0,
  );
});

Deno.test("clean opted-in pull request is reread immediately before squash merge", async () => {
  const mock = new MockGitHubClient();
  let reads = 0;
  mockCompare(mock);
  mock.on(listPullsRoute, () => [makePull()]);
  mock.on(getPullRoute, () => {
    reads++;
    return makePull({
      mergeable_state: reads === 1 ? "behind" : "clean",
      head: {
        label: "upstream:main",
        sha: reads === 1 ? "stale-head-sha" : "fresh-head-sha",
      },
    });
  });
  mock.on(mergeRoute, () => ({ merged: true }));

  await processRule(
    repository,
    makeRule({ autoMerge: true, mergeMethod: "squash" }),
    mock,
  );

  assertEquals(mock.calls.map((call) => call.route), [
    compareRoute,
    listPullsRoute,
    getPullRoute,
    getPullRoute,
    mergeRoute,
  ]);
  const merge = mock.calls.find((call) => call.route === mergeRoute);
  assertEquals(merge?.parameters?.merge_method, "squash");
  assertEquals(merge?.parameters?.sha, "fresh-head-sha");
});

Deno.test("merge is skipped when the immediate reread becomes dirty", async () => {
  const mock = new MockGitHubClient();
  let reads = 0;
  mockCompare(mock);
  mock.on(listPullsRoute, () => [makePull()]);
  mock.on(getPullRoute, () => {
    reads++;
    return makePull({
      mergeable: reads === 1 ? true : false,
      mergeable_state: reads === 1 ? "clean" : "dirty",
      labels: reads === 1 ? [{ name: "upstream-sync" }] : [
        { name: "upstream-sync" },
        { name: "merge-conflict" },
      ],
    });
  });

  await processRule(
    repository,
    makeRule({ autoMerge: true, mergeMethod: "merge" }),
    mock,
  );

  assertEquals(reads, 2);
  assertEquals(mock.calls.some((call) => call.route === mergeRoute), false);
});

Deno.test("opted-in hardreset uses the explicit upstream ref instead of a truncated compare commit", async () => {
  const mock = new MockGitHubClient();
  mockCompare(mock, "stale-truncated-compare-sha");
  mock.on(repositoryRoute, () => ({
    name: "example",
    owner: { login: "octocat" },
    parent: { name: "original", owner: { login: "upstream" } },
    source: { name: "original", owner: { login: "upstream" } },
  }));
  mock.on(upstreamRefRoute, (parameters) => {
    assertEquals(parameters, {
      owner: "upstream",
      repo: "original",
      ref: "main",
    });
    return { object: { sha: "authoritative-upstream-head-sha" } };
  });
  mock.on(resetRoute, () => ({}));

  await processRule(
    repository,
    makeRule({ autoMerge: true, mergeMethod: "hardreset" }),
    mock,
  );

  assertEquals(mock.calls.map((call) => call.route), [
    compareRoute,
    repositoryRoute,
    upstreamRefRoute,
    resetRoute,
  ]);
  assertEquals(mock.calls[3].parameters, {
    owner: "octocat",
    repo: "example",
    ref: "main",
    sha: "authoritative-upstream-head-sha",
    force: true,
  });
});

Deno.test("hardreset skips when the upstream repository or explicit ref SHA is missing", async () => {
  for (
    const testCase of [
      {
        metadata: {
          name: "example",
          owner: { login: "octocat" },
          parent: { name: "unrelated", owner: { login: "other" } },
          source: null,
        },
        refResponse: undefined,
        expectedRoutes: [compareRoute, repositoryRoute],
      },
      {
        metadata: {
          name: "example",
          owner: { login: "octocat" },
          parent: { name: "original", owner: { login: "upstream" } },
          source: null,
        },
        refResponse: { object: {} },
        expectedRoutes: [compareRoute, repositoryRoute, upstreamRefRoute],
      },
    ]
  ) {
    const mock = new MockGitHubClient();
    mockCompare(mock, "stale-truncated-compare-sha");
    mock.on(repositoryRoute, () => testCase.metadata);
    if (testCase.refResponse !== undefined) {
      mock.on(upstreamRefRoute, () => testCase.refResponse);
    }
    mock.on(resetRoute, () => ({}));

    await processRule(
      repository,
      makeRule({ autoMerge: true, mergeMethod: "hardreset" }),
      mock,
    );

    assertEquals(mock.calls.map((call) => call.route), testCase.expectedRoutes);
    assertEquals(mock.mutations, []);
  }
});

Deno.test("hardreset without autoMerge follows the safe pull-request-only path", async () => {
  const mock = new MockGitHubClient();
  mockCompare(mock);
  mockExistingPull(mock, makePull());

  await processRule(
    repository,
    makeRule({ autoMerge: false, mergeMethod: "hardreset" }),
    mock,
  );

  assertEquals(mock.calls.some((call) => call.route === resetRoute), false);
  assertEquals(mock.calls.some((call) => call.route === mergeRoute), false);
  assertEquals(mock.calls.some((call) => call.route === listPullsRoute), true);
});

Deno.test("missing configuration produces no API mutation", async () => {
  const mock = new MockGitHubClient();
  mock.on(contentsRoute, (parameters) => {
    assertEquals(parameters.path, ".github/arshite.yml");
    assertEquals(parameters.ref, "main");
    throw { status: 404 };
  });

  await processRepository(repository, mock, "arshite.yml");

  assertEquals(mock.calls.map((call) => call.route), [contentsRoute]);
  assertEquals(mock.mutations, []);
});

Deno.test("invalid configuration throws a safe ConfigurationError without logging secrets", async () => {
  const mock = new MockGitHubClient();
  const secret = "super-secret-value";
  const yaml =
    `version: "1"\ncredential: ${secret}\nrules:\n  - base: main\n    upstream: upstream:main\n`;
  mock.on(contentsRoute, () => ({ content: btoa(yaml), encoding: "base64" }));
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const logs: string[] = [];
  const capture = (...values: unknown[]) =>
    logs.push(values.map(String).join(" "));
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;

  try {
    const error = await assertRejects(
      () => processRepository(repository, mock, "arshite.yml"),
      ConfigurationError,
    ) as ConfigurationError;
    assertStringIncludes(error.message, "octocat/example");
    assertEquals(error.message.includes(secret), false);
    assertEquals(error.message.includes(yaml), false);
    assertEquals(logs.join("\n").includes(secret), false);
    assertEquals(logs.join("\n").includes(yaml), false);
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
});

Deno.test("unsafe pull request states and autoMerge false are never merged", async () => {
  const cases: Array<{
    name: string;
    pull: TestPullRequest;
    rule: Rule;
  }> = [
    ...["blocked", "dirty", "behind", "unknown"].map((state) => ({
      name: state,
      pull: makePull({
        mergeable: state === "dirty" ? false : true,
        mergeable_state: state,
        labels: state === "dirty"
          ? [{ name: "upstream-sync" }, { name: "merge-conflict" }]
          : [{ name: "upstream-sync" }],
      }),
      rule: makeRule({ autoMerge: true, mergeMethod: "merge" }),
    })),
    {
      name: "draft",
      pull: makePull({ draft: true }),
      rule: makeRule({ autoMerge: true, mergeMethod: "merge" }),
    },
    {
      name: "wrong head",
      pull: makePull({
        head: { label: "other:main", sha: "other-head-sha" },
      }),
      rule: makeRule({ autoMerge: true, mergeMethod: "merge" }),
    },
    {
      name: "wrong base",
      pull: makePull({ base: { ref: "release" } }),
      rule: makeRule({ autoMerge: true, mergeMethod: "merge" }),
    },
    {
      name: "autoMerge false",
      pull: makePull(),
      rule: makeRule({ autoMerge: false, mergeMethod: "merge" }),
    },
  ];

  for (const testCase of cases) {
    const mock = new MockGitHubClient();
    mockCompare(mock);
    mockExistingPull(mock, testCase.pull);
    await processRule(repository, testCase.rule, mock);
    assertEquals(
      mock.calls.some((call) => call.route === mergeRoute),
      false,
      testCase.name,
    );
  }
});

Deno.test("expected merge rejections leave the pull request open and log only safe metadata", async () => {
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]) =>
    logs.push(values.map(String).join(" "));

  try {
    for (const status of [405, 409, 422]) {
      const mock = new MockGitHubClient();
      mockCompare(mock);
      mockExistingPull(mock, makePull());
      mock.on(mergeRoute, () => {
        throw {
          status,
          response: { data: { message: "sensitive-merge-payload" } },
        };
      });

      await processRule(
        repository,
        makeRule({ autoMerge: true, mergeMethod: "merge" }),
        mock,
      );

      assertEquals(mock.mutations.map((call) => call.route), [mergeRoute]);
    }
    const output = logs.join("\n");
    assertStringIncludes(output, "octocat/example");
    for (const status of [405, 409, 422]) {
      assertStringIncludes(output, String(status));
    }
    assertStringIncludes(output, "#7");
    assertEquals(output.includes("sensitive-merge-payload"), false);
  } finally {
    console.error = originalError;
  }
});

Deno.test("unexpected merge errors propagate", async () => {
  const mock = new MockGitHubClient();
  mockCompare(mock);
  mockExistingPull(mock, makePull());
  mock.on(mergeRoute, () => {
    throw { status: 500 };
  });

  const error = await assertRejects(() =>
    processRule(
      repository,
      makeRule({ autoMerge: true, mergeMethod: "merge" }),
      mock,
    )
  );
  assertEquals((error as { status: number }).status, 500);
});

Deno.test("conflict label cleanup ignores only a missing-label response", async () => {
  for (const status of [404, 500]) {
    const mock = new MockGitHubClient();
    mockCompare(mock);
    mockExistingPull(
      mock,
      makePull({
        labels: [{ name: "upstream-sync" }, { name: "merge-conflict" }],
      }),
    );
    mock.on(deleteLabelRoute, () => {
      throw { status };
    });

    const run = () => processRule(repository, makeRule(), mock);
    if (status === 404) {
      await run();
    } else {
      const error = await assertRejects(run);
      assertEquals((error as { status: number }).status, 500);
    }
  }
});

Deno.test("permanent compare errors skip only the affected rule with safe metadata logs", async () => {
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]) =>
    logs.push(values.map(String).join(" "));

  try {
    for (
      const testCase of [
        { name: "missing base", status: 404 },
        { name: "missing upstream", status: 404 },
        { name: "inaccessible upstream", status: 422 },
      ]
    ) {
      const mock = new MockGitHubClient();
      mock.on(compareRoute, () => {
        throw {
          status: testCase.status,
          response: { data: { message: `secret-${testCase.name}` } },
        };
      });

      await processRule(repository, makeRule(), mock);

      assertEquals(mock.calls.map((call) => call.route), [compareRoute]);
      assertEquals(mock.mutations, []);
    }

    const output = logs.join("\n");
    assertStringIncludes(output, "octocat/example");
    assertStringIncludes(output, "upstream:main");
    assertStringIncludes(output, "404");
    assertStringIncludes(output, "422");
    assertEquals(output.includes("secret-"), false);
  } finally {
    console.error = originalError;
  }
});

Deno.test("processRepository continues later rules after a permanent compare failure", async () => {
  const mock = new MockGitHubClient();
  const yaml =
    `version: "1"\nrules:\n  - base: main\n    upstream: missing:main\n  - base: release\n    upstream: upstream:dev\n`;
  mock.on(contentsRoute, () => ({ content: btoa(yaml), encoding: "base64" }));
  const compared: string[] = [];
  mock.on(compareRoute, (parameters) => {
    const basehead = String(parameters.basehead);
    compared.push(basehead);
    if (basehead === "main...missing:main") {
      throw { status: 404, response: { data: { message: "private" } } };
    }
    return { ahead_by: 0, commits: [] };
  });
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]) =>
    logs.push(values.map(String).join(" "));

  try {
    await processRepository(repository, mock, "arshite.yml");
  } finally {
    console.error = originalError;
  }

  assertEquals(compared, ["main...missing:main", "release...upstream:dev"]);
  assertEquals(logs.join("\n").includes("private"), false);
});

Deno.test("transient compare failures propagate without running later rules", async () => {
  for (const error of [new Error("network unavailable"), { status: 500 }]) {
    const mock = new MockGitHubClient();
    const yaml =
      `version: "1"\nrules:\n  - base: main\n    upstream: upstream:main\n  - base: release\n    upstream: second:dev\n`;
    mock.on(contentsRoute, () => ({ content: btoa(yaml), encoding: "base64" }));
    const compared: string[] = [];
    mock.on(compareRoute, (parameters) => {
      compared.push(String(parameters.basehead));
      throw error;
    });

    const rejected = await assertRejects(() =>
      processRepository(repository, mock, "arshite.yml")
    );
    assertEquals(rejected, error);
    assertEquals(compared, ["main...upstream:main"]);
  }
});

Deno.test("processRepository logs invalid rule indexes and processes valid rules", async () => {
  const mock = new MockGitHubClient();
  const secret = "invalid-rule-secret";
  const yaml =
    `version: "1"\nrules:\n  - base: main\n    upstream: upstream:main\n    credential: ${secret}\n  - base: release\n    upstream: second:dev\n`;
  mock.on(contentsRoute, () => ({ content: btoa(yaml), encoding: "base64" }));
  const compared: string[] = [];
  mock.on(compareRoute, (parameters) => {
    compared.push(String(parameters.basehead));
    return { ahead_by: 0, commits: [] };
  });
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]) =>
    logs.push(values.map(String).join(" "));

  try {
    await processRepository(repository, mock, "arshite.yml");
  } finally {
    console.error = originalError;
  }

  assertEquals(compared, ["release...second:dev"]);
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "octocat/example");
  assertStringIncludes(logs[0], "rule=0");
  assertEquals(logs[0].includes(secret), false);
  assertEquals(logs[0].includes("credential"), false);
});

Deno.test("processRepository decodes configuration and processes rules sequentially", async () => {
  const mock = new MockGitHubClient();
  const yaml =
    `version: "1"\nrules:\n  - base: main\n    upstream: upstream:main\n  - base: release\n    upstream: second:dev\n`;
  mock.on(contentsRoute, () => ({ content: btoa(yaml), encoding: "base64" }));
  const compared: string[] = [];
  let releaseFirstCompare!: () => void;
  const firstCompareStarted = new Promise<void>((resolve) => {
    releaseFirstCompare = resolve;
  });
  let unblockFirstCompare!: () => void;
  const firstCompareBlocked = new Promise<void>((resolve) => {
    unblockFirstCompare = resolve;
  });
  mock.on(compareRoute, async (parameters) => {
    const basehead = String(parameters.basehead);
    compared.push(basehead);
    if (basehead === "main...upstream:main") {
      releaseFirstCompare();
      await firstCompareBlocked;
    }
    return { ahead_by: 0, commits: [] };
  });

  const processing = processRepository(repository, mock, "arshite.yml");
  await firstCompareStarted;
  assertEquals(compared, ["main...upstream:main"]);
  unblockFirstCompare();
  await processing;

  assertEquals(compared, ["main...upstream:main", "release...second:dev"]);
});

Deno.test("configuration read failures other than 404 propagate", async () => {
  const mock = new MockGitHubClient();
  mock.on(contentsRoute, () => {
    throw { status: 500 };
  });

  const error = await assertRejects(() =>
    processRepository(repository, mock, "arshite.yml")
  );
  assertEquals((error as { status: number }).status, 500);
});
