import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createHandler,
  type HandlerDeps,
  processAllRepositories,
  type RepositoryProcessor,
} from "../src/handler.ts";
import { ConfigurationError } from "../src/processor.ts";
import { Registry } from "../src/registry.ts";
import type { GitHubClient, RepositoryRecord } from "../src/types.ts";

const webhookSecret = "test-webhook-secret";
const encoder = new TextEncoder();

type ApiParameters = Record<string, unknown>;
type ApiHandler = (parameters: ApiParameters) => unknown | Promise<unknown>;

interface ApiCall {
  route: string;
  parameters: ApiParameters;
}

class FakeGitHubClient implements GitHubClient {
  readonly calls: ApiCall[] = [];
  private readonly handlers = new Map<string, ApiHandler>();

  on(route: string, handler: ApiHandler): void {
    this.handlers.set(route, handler);
  }

  async request<T>(
    route: string,
    parameters: ApiParameters = {},
  ): Promise<{ data: T }> {
    this.calls.push({ route, parameters });
    const handler = this.handlers.get(route);
    if (!handler) throw new Error(`Unexpected GitHub route: ${route}`);
    return { data: await handler(parameters) as T };
  }
}

interface Harness {
  kv: Deno.Kv;
  registry: Registry;
  deps: HandlerDeps;
  handler: (request: Request) => Promise<Response>;
  client: FakeGitHubClient;
  processingAttempts: RepositoryRecord[];
  installationIds: number[];
  logs: string[];
}

async function createHarness(
  behavior?: (
    ...parameters: Parameters<RepositoryProcessor>
  ) => void | Promise<void>,
): Promise<Harness> {
  const kv = await Deno.openKv(":memory:");
  const registry = new Registry(kv);
  const client = new FakeGitHubClient();
  const processingAttempts: RepositoryRecord[] = [];
  const installationIds: number[] = [];
  const logs: string[] = [];
  const processRepository: RepositoryProcessor = async (
    repository: RepositoryRecord,
    installationClient: GitHubClient,
    configFilename: string,
  ) => {
    assertEquals(installationClient, client);
    assertEquals(configFilename, "pull.yml");
    processingAttempts.push(repository);
    await behavior?.(repository, installationClient, configFilename);
  };
  const deps: HandlerDeps = {
    env: { webhookSecret, configFilename: "pull.yml" },
    registry,
    getInstallationClient: (installationId: number) => {
      installationIds.push(installationId);
      return Promise.resolve(client);
    },
    processRepository,
    logger: (message: string) => logs.push(message),
  };

  return {
    kv,
    registry,
    deps,
    handler: createHandler(deps),
    client,
    processingAttempts,
    installationIds,
    logs,
  };
}

function makeRepository(
  overrides: Partial<RepositoryRecord> = {},
): RepositoryRecord {
  return {
    id: 1,
    installationId: 10,
    owner: "octocat",
    repo: "example",
    defaultBranch: "main",
    suspended: false,
    ...overrides,
  };
}

function repositoryPayload(
  repository: RepositoryRecord,
): Record<string, unknown> {
  return {
    id: repository.id,
    name: repository.repo,
    full_name: `${repository.owner}/${repository.repo}`,
    default_branch: repository.defaultBranch,
    owner: { login: repository.owner },
  };
}

const installationRepositoriesRoute = "GET /installation/repositories";

function mockInstallationListing(
  harness: Harness,
  pages: Array<Array<Record<string, unknown>>>,
): void {
  harness.client.on(installationRepositoriesRoute, (parameters) => {
    assertEquals(parameters.per_page, 100);
    const page = parameters.page as number;
    return {
      total_count: pages.flat().length,
      repositories: pages[page - 1] ?? [],
    };
  });
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(body),
  );
  const hex = Array.from(
    new Uint8Array(signature),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256=${hex}`;
}

interface WebhookOptions {
  event?: string | null;
  delivery: string | null;
  body: string;
  signature?: string | null;
  contentType?: string;
}

async function sendWebhook(
  harness: Harness,
  options: WebhookOptions,
): Promise<Response> {
  const event = options.event === undefined ? "push" : options.event;
  const signature = options.signature === undefined
    ? await sign(options.body)
    : options.signature;
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/json",
  };
  if (event !== null) headers["x-github-event"] = event;
  if (options.delivery !== null) {
    headers["x-github-delivery"] = options.delivery;
  }
  if (signature !== null) headers["x-hub-signature-256"] = signature;

  return await harness.handler(
    new Request("http://localhost/api/github/webhooks", {
      method: "POST",
      headers,
      body: options.body,
    }),
  );
}

async function sendJson(
  harness: Harness,
  event: string,
  delivery: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return await sendWebhook(harness, {
    event,
    delivery,
    body: JSON.stringify(payload),
  });
}

Deno.test("health is minimal and unknown routes return 404", async () => {
  const harness = await createHarness();
  try {
    const health = await harness.handler(
      new Request("http://localhost/health"),
    );
    assertEquals(health.status, 200);
    assertEquals(await health.json(), { status: "ok" });

    const unknown = await harness.handler(
      new Request("http://localhost/not-a-route"),
    );
    assertEquals(unknown.status, 404);
  } finally {
    harness.kv.close();
  }
});

Deno.test("missing and invalid signatures are rejected before JSON parsing", async () => {
  const harness = await createHarness();
  try {
    const missing = await sendWebhook(harness, {
      delivery: "missing-signature",
      body: "{",
      signature: null,
    });
    assertEquals(missing.status, 401);

    const invalid = await sendWebhook(harness, {
      delivery: "invalid-signature",
      body: "{",
      signature: `sha256=${"0".repeat(64)}`,
    });
    assertEquals(invalid.status, 401);
    assertEquals(harness.processingAttempts, []);
  } finally {
    harness.kv.close();
  }
});

Deno.test("webhook content and metadata validation return appropriate 4xx responses", async () => {
  const harness = await createHarness();
  try {
    const unsupported = await sendWebhook(harness, {
      delivery: "wrong-content-type",
      body: "{}",
      contentType: "text/plain",
    });
    assertEquals(unsupported.status, 415);

    const missingEvent = await sendWebhook(harness, {
      event: null,
      delivery: "missing-event",
      body: "{}",
    });
    assertEquals(missingEvent.status, 400);

    const missingDelivery = await sendWebhook(harness, {
      delivery: null,
      body: "{}",
    });
    assertEquals(missingDelivery.status, 400);

    const malformed = await sendWebhook(harness, {
      delivery: "malformed-json",
      body: "{",
    });
    assertEquals(malformed.status, 400);
  } finally {
    harness.kv.close();
  }
});

Deno.test("valid unsupported events are acknowledged without processing", async () => {
  const harness = await createHarness();
  try {
    const response = await sendJson(
      harness,
      "issues",
      "unsupported-event",
      { action: "opened", issue: { number: 1 } },
    );

    assertEquals(response.status, 200);
    assertEquals(harness.processingAttempts, []);
    assertEquals(harness.installationIds, []);
  } finally {
    harness.kv.close();
  }
});

Deno.test("successfully processed deliveries suppress duplicate work", async () => {
  const harness = await createHarness();
  try {
    const repository = makeRepository();
    await harness.registry.upsertRepository(repository);
    const payload = { repository: repositoryPayload(repository) };

    assertEquals(
      (await sendJson(harness, "push", "duplicate-delivery", payload)).status,
      200,
    );
    assertEquals(
      (await sendJson(harness, "push", "duplicate-delivery", payload)).status,
      200,
    );

    assertEquals(harness.processingAttempts, [repository]);
    assertEquals(
      await harness.registry.wasDeliveryProcessed("duplicate-delivery"),
      true,
    );
  } finally {
    harness.kv.close();
  }
});

Deno.test("installation creation reconciles sparse payloads from authoritative metadata", async () => {
  const harness = await createHarness();
  try {
    const installation = { id: 42, account: { login: "octocat" } };
    const sparseRepositories = [
      { id: 1, name: "first", full_name: "octocat/first" },
      { id: 2, name: "second", full_name: "octocat/second" },
    ];
    const first = makeRepository({
      installationId: 42,
      repo: "first",
      defaultBranch: "develop",
    });
    const second = makeRepository({
      id: 2,
      installationId: 42,
      repo: "second",
      defaultBranch: "trunk",
    });
    mockInstallationListing(harness, [[
      repositoryPayload(first),
      repositoryPayload(second),
    ]]);

    assertEquals(
      (await sendJson(harness, "installation", "install-created", {
        action: "created",
        installation,
        repositories: sparseRepositories,
      })).status,
      200,
    );
    assertEquals(await harness.registry.listRepositories(42), [first, second]);
    const listingCalls = harness.client.calls.length;

    await sendJson(harness, "installation", "install-suspended", {
      action: "suspend",
      installation,
    });
    assertEquals(await harness.registry.listRepositories(42), [
      { ...first, suspended: true },
      { ...second, suspended: true },
    ]);

    await sendJson(harness, "installation", "install-unsuspended", {
      action: "unsuspend",
      installation,
    });
    assertEquals(await harness.registry.listRepositories(42), [first, second]);

    await sendJson(harness, "installation", "install-deleted", {
      action: "deleted",
      installation,
    });
    assertEquals(await harness.registry.listRepositories(42), []);
    assertEquals(harness.client.calls.length, listingCalls);
    assertEquals(harness.processingAttempts, []);
  } finally {
    harness.kv.close();
  }
});

Deno.test("installation repository access changes reconcile from complete listings", async () => {
  const harness = await createHarness();
  try {
    const repository = makeRepository({
      installationId: 42,
      defaultBranch: "trunk",
    });
    const payloadRepository = repositoryPayload(repository);
    const sparseRepository = {
      id: repository.id,
      name: repository.repo,
      full_name: `${repository.owner}/${repository.repo}`,
    };
    mockInstallationListing(harness, [[payloadRepository]]);

    const added = await sendJson(
      harness,
      "installation_repositories",
      "installation-repository-added",
      {
        action: "added",
        installation: { id: 42, account: { login: "octocat" } },
        repositories_added: [sparseRepository],
        repositories_removed: [],
      },
    );
    assertEquals(added.status, 200);
    assertEquals(await harness.registry.getRepository(1), repository);

    mockInstallationListing(harness, [[]]);
    const removed = await sendJson(
      harness,
      "installation_repositories",
      "installation-repository-removed",
      {
        action: "removed",
        installation: { id: 42, account: { login: "octocat" } },
        repositories_added: [],
        repositories_removed: [sparseRepository],
      },
    );
    assertEquals(removed.status, 200);
    assertEquals(await harness.registry.getRepository(1), null);
    assertEquals(harness.processingAttempts, []);
  } finally {
    harness.kv.close();
  }
});

Deno.test("all-to-selected transitions remove stale records even with an empty removed list", async () => {
  const harness = await createHarness();
  try {
    const retained = makeRepository({
      installationId: 42,
      defaultBranch: "trunk",
    });
    const stale = makeRepository({ id: 2, installationId: 42, repo: "stale" });
    await harness.registry.upsertRepository({
      ...retained,
      defaultBranch: "old",
    });
    await harness.registry.upsertRepository(stale);
    mockInstallationListing(harness, [[repositoryPayload(retained)]]);

    const response = await sendJson(
      harness,
      "installation_repositories",
      "all-to-selected",
      {
        action: "removed",
        installation: { id: 42, account: { login: "octocat" } },
        repositories_added: [],
        repositories_removed: [],
      },
    );

    assertEquals(response.status, 200);
    assertEquals(await harness.registry.listRepositories(42), [retained]);
    assertEquals(await harness.registry.getRepository(stale.id), null);
  } finally {
    harness.kv.close();
  }
});

Deno.test("installation reconciliation retrieves every page before removing stale records", async () => {
  const harness = await createHarness();
  try {
    const repositories = Array.from(
      { length: 101 },
      (_, index) =>
        makeRepository({
          id: index + 1,
          installationId: 42,
          repo: `repo-${index + 1}`,
        }),
    );
    const stale = makeRepository({
      id: 999,
      installationId: 42,
      repo: "stale",
    });
    await harness.registry.upsertRepository(stale);
    mockInstallationListing(harness, [
      repositories.slice(0, 100).map(repositoryPayload),
      repositories.slice(100).map(repositoryPayload),
    ]);

    const response = await sendJson(
      harness,
      "installation",
      "paginated-install",
      {
        action: "created",
        installation: { id: 42, account: { login: "octocat" } },
        repositories: [],
      },
    );

    assertEquals(response.status, 200);
    assertEquals((await harness.registry.listRepositories(42)).length, 101);
    assertEquals(await harness.registry.getRepository(stale.id), null);
    assertEquals(
      harness.client.calls.map((call) => call.parameters.page),
      [1, 2],
    );
  } finally {
    harness.kv.close();
  }
});

Deno.test("a failed later listing page leaves the existing registry unchanged", async () => {
  const harness = await createHarness();
  try {
    const existing = makeRepository({
      installationId: 42,
      defaultBranch: "old",
    });
    const stale = makeRepository({ id: 2, installationId: 42, repo: "stale" });
    await harness.registry.upsertRepository(existing);
    await harness.registry.upsertRepository(stale);
    const firstPage = Array.from(
      { length: 100 },
      (_, index) =>
        repositoryPayload(makeRepository({
          id: index + 1,
          installationId: 42,
          repo: `repo-${index + 1}`,
          defaultBranch: "new",
        })),
    );
    harness.client.on(installationRepositoriesRoute, (parameters) => {
      if (parameters.page === 2) throw { status: 500 };
      return { total_count: 101, repositories: firstPage };
    });

    const response = await sendJson(harness, "installation", "failed-listing", {
      action: "created",
      installation: { id: 42, account: { login: "octocat" } },
      repositories: [],
    });

    assertEquals(response.status, 500);
    assertEquals(await harness.registry.getRepository(existing.id), existing);
    assertEquals(await harness.registry.getRepository(stale.id), stale);
  } finally {
    harness.kv.close();
  }
});

Deno.test("repository events process only registered active repositories and associated checks", async () => {
  const harness = await createHarness();
  try {
    const repository = makeRepository();
    const suspended = makeRepository({
      id: 2,
      repo: "suspended",
      suspended: true,
    });
    await harness.registry.upsertRepository(repository);
    await harness.registry.upsertRepository(suspended);
    const payload = repositoryPayload(repository);
    const supportedEvents: Array<[string, Record<string, unknown>]> = [
      ["push", { repository: payload }],
      ["pull_request", { repository: payload }],
      ["check_run", {
        repository: payload,
        check_run: { pull_requests: [{ number: 7 }] },
      }],
      ["check_suite", {
        repository: payload,
        check_suite: { pull_requests: [{ number: 7 }] },
      }],
      ["status", { repository: payload }],
    ];

    for (const [index, [event, eventPayload]] of supportedEvents.entries()) {
      const response = await sendJson(
        harness,
        event,
        `supported-event-${index}`,
        eventPayload,
      );
      assertEquals(response.status, 200);
    }
    assertEquals(
      harness.processingAttempts.map(({ id }) => id),
      [1, 1, 1, 1, 1],
    );
    assertEquals(harness.installationIds, [10, 10, 10, 10, 10]);

    const ignoredEvents: Array<[string, Record<string, unknown>]> = [
      ["check_run", {
        repository: payload,
        check_run: { pull_requests: [] },
      }],
      ["check_suite", {
        repository: payload,
        check_suite: { pull_requests: [] },
      }],
      ["push", { repository: repositoryPayload(suspended) }],
      ["push", {
        repository: repositoryPayload(makeRepository({ id: 999 })),
      }],
      ["push", {}],
    ];
    for (const [index, [event, eventPayload]] of ignoredEvents.entries()) {
      const response = await sendJson(
        harness,
        event,
        `ignored-event-${index}`,
        eventPayload,
      );
      assertEquals(response.status, 200);
    }
    assertEquals(harness.processingAttempts.length, 5);
    assertEquals(harness.installationIds.length, 5);
  } finally {
    harness.kv.close();
  }
});

Deno.test("configuration errors are safely acknowledged while transient failures remain retryable", async () => {
  let failure: "configuration" | "transient" | "none" = "configuration";
  const harness = await createHarness((repository: RepositoryRecord) => {
    if (failure === "configuration") {
      throw new ConfigurationError(repository);
    }
    if (failure === "transient") {
      throw new Error("token-secret\nsensitive stack trace");
    }
  });
  try {
    const repository = makeRepository();
    await harness.registry.upsertRepository(repository);
    const payload = {
      repository: repositoryPayload(repository),
      private: "payload-secret",
    };

    const configured = await sendJson(
      harness,
      "push",
      "configuration-failure",
      payload,
    );
    assertEquals(configured.status, 200);
    assertEquals(
      await harness.registry.wasDeliveryProcessed("configuration-failure"),
      true,
    );

    failure = "none";
    assertEquals(
      (await sendJson(
        harness,
        "push",
        "configuration-failure",
        payload,
      )).status,
      200,
    );
    assertEquals(harness.processingAttempts.length, 1);

    failure = "transient";
    const transient = await sendJson(
      harness,
      "push",
      "transient-failure",
      payload,
    );
    assertEquals(transient.status, 500);
    assertEquals(
      await harness.registry.wasDeliveryProcessed("transient-failure"),
      false,
    );
    assertStringIncludes(await transient.text(), "error");

    failure = "none";
    assertEquals(
      (await sendJson(harness, "push", "transient-failure", payload)).status,
      200,
    );
    assertEquals(harness.processingAttempts.length, 3);

    const observableText = harness.logs.join("\n");
    assertEquals(observableText.includes(webhookSecret), false);
    assertEquals(observableText.includes("payload-secret"), false);
    assertEquals(observableText.includes("token-secret"), false);
    assertEquals(observableText.includes("stack trace"), false);
  } finally {
    harness.kv.close();
  }
});

Deno.test("repository leases return retryable contention and release after success and failure", async () => {
  let shouldFail = false;
  const harness = await createHarness(() => {
    if (shouldFail) throw new Error("transient failure");
  });
  try {
    const repository = makeRepository();
    await harness.registry.upsertRepository(repository);
    const payload = { repository: repositoryPayload(repository) };
    assertEquals(
      await harness.registry.acquireLease(1, "other-owner", 60_000),
      true,
    );

    assertEquals(
      (await sendJson(harness, "push", "lease-contention", payload)).status,
      503,
    );
    assertEquals(harness.processingAttempts, []);
    assertEquals(
      await harness.registry.wasDeliveryProcessed("lease-contention"),
      false,
    );
    await harness.registry.releaseLease(1, "other-owner");

    assertEquals(
      (await sendJson(harness, "push", "lease-success", payload)).status,
      200,
    );
    assertEquals(harness.processingAttempts.length, 1);
    assertEquals(
      await harness.registry.acquireLease(1, "after-success", 60_000),
      true,
    );
    await harness.registry.releaseLease(1, "after-success");

    shouldFail = true;
    assertEquals(
      (await sendJson(harness, "push", "lease-failure", payload)).status,
      500,
    );
    assertEquals(harness.processingAttempts.length, 2);
    assertEquals(
      await harness.registry.acquireLease(1, "after-failure", 60_000),
      true,
    );
    await harness.registry.releaseLease(1, "after-failure");
  } finally {
    harness.kv.close();
  }
});

Deno.test("concurrent duplicate delivery stays retryable when the lease owner fails", async () => {
  let releaseProcessing!: () => void;
  const processingBlocked = new Promise<void>((resolve) => {
    releaseProcessing = resolve;
  });
  let markProcessingStarted!: () => void;
  const processingStarted = new Promise<void>((resolve) => {
    markProcessingStarted = resolve;
  });
  let shouldFail = true;
  const harness = await createHarness(async () => {
    markProcessingStarted();
    await processingBlocked;
    if (shouldFail) throw new Error("lease owner failed");
  });
  try {
    const repository = makeRepository();
    await harness.registry.upsertRepository(repository);
    const payload = { repository: repositoryPayload(repository) };
    const first = sendJson(harness, "push", "concurrent-duplicate", payload);
    await processingStarted;

    const busy = await sendJson(
      harness,
      "push",
      "concurrent-duplicate",
      payload,
    );
    assertEquals(busy.status, 503);
    assertEquals(await busy.json(), { status: "busy" });
    releaseProcessing();
    assertEquals((await first).status, 500);
    assertEquals(
      await harness.registry.wasDeliveryProcessed("concurrent-duplicate"),
      false,
    );

    shouldFail = false;
    const retry = await sendJson(
      harness,
      "push",
      "concurrent-duplicate",
      payload,
    );
    assertEquals(retry.status, 200);
    assertEquals(harness.processingAttempts.length, 2);
    assertEquals(
      await harness.registry.wasDeliveryProcessed("concurrent-duplicate"),
      true,
    );
  } finally {
    harness.kv.close();
  }
});

Deno.test("different deliveries contending for one repository can each retry", async () => {
  let releaseProcessing!: () => void;
  const processingBlocked = new Promise<void>((resolve) => {
    releaseProcessing = resolve;
  });
  let markProcessingStarted!: () => void;
  const processingStarted = new Promise<void>((resolve) => {
    markProcessingStarted = resolve;
  });
  const harness = await createHarness(async () => {
    markProcessingStarted();
    await processingBlocked;
  });
  try {
    const repository = makeRepository();
    await harness.registry.upsertRepository(repository);
    const payload = { repository: repositoryPayload(repository) };
    const first = sendJson(harness, "push", "first-delivery", payload);
    await processingStarted;

    const busy = await sendJson(harness, "push", "second-delivery", payload);
    assertEquals(busy.status, 503);
    assertEquals(
      await harness.registry.wasDeliveryProcessed("second-delivery"),
      false,
    );
    releaseProcessing();
    assertEquals((await first).status, 200);
    assertEquals(
      await harness.registry.wasDeliveryProcessed("first-delivery"),
      true,
    );

    const retry = await sendJson(harness, "push", "second-delivery", payload);
    assertEquals(retry.status, 200);
    assertEquals(harness.processingAttempts.length, 2);
    assertEquals(
      await harness.registry.wasDeliveryProcessed("second-delivery"),
      true,
    );
  } finally {
    harness.kv.close();
  }
});

Deno.test("cron processing isolates failures and skips suspended repositories", async () => {
  const harness = await createHarness((repository: RepositoryRecord) => {
    if (repository.id === 1) throw new Error("failure-secret");
  });
  try {
    const first = makeRepository({ repo: "first" });
    const suspended = makeRepository({
      id: 2,
      installationId: 20,
      repo: "suspended",
      suspended: true,
    });
    const third = makeRepository({
      id: 3,
      installationId: 30,
      repo: "third",
    });
    await harness.registry.upsertRepository(first);
    await harness.registry.upsertRepository(suspended);
    await harness.registry.upsertRepository(third);

    await processAllRepositories(harness.deps);

    assertEquals(
      harness.processingAttempts.map(({ id }) => id),
      [1, 3],
    );
    assertEquals(harness.installationIds, [10, 30]);
    assertEquals(harness.logs.length, 1);
    assertStringIncludes(harness.logs[0], "octocat/first");
    assertEquals(harness.logs[0].includes("failure-secret"), false);
    for (const repository of [first, third]) {
      assertEquals(
        await harness.registry.acquireLease(
          repository.id,
          `after-cron-${repository.id}`,
          60_000,
        ),
        true,
      );
      await harness.registry.releaseLease(
        repository.id,
        `after-cron-${repository.id}`,
      );
    }
  } finally {
    harness.kv.close();
  }
});
