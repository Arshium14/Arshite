import { ConfigurationError, processRepository } from "./processor.ts";
import type { Registry } from "./registry.ts";
import type { WebhookPayload } from "./webhooks.ts";
import { parseWebhook, verifyWebhookSignature } from "./webhooks.ts";
import type { AppEnv, GitHubClient, RepositoryRecord } from "./types.ts";

export type RepositoryProcessor = typeof processRepository;
export type SafeLogger = (message: string) => void;
type RepositoryProcessingResult = "processed" | "busy";

export interface HandlerDeps {
  env: Pick<AppEnv, "webhookSecret" | "configFilename">;
  registry: Registry;
  getInstallationClient(installationId: number): Promise<GitHubClient>;
  processRepository?: RepositoryProcessor;
  logger?: SafeLogger;
}

function log(deps: HandlerDeps, message: string): void {
  try {
    (deps.logger ?? console.error)(message);
  } catch {
    // Logging must not change webhook acknowledgement or cron batch isolation.
  }
}

function jsonResponse(body: Record<string, string>, status = 200): Response {
  return Response.json(body, { status });
}

function objectValue(value: unknown): WebhookPayload | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as WebhookPayload
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function installationId(payload: WebhookPayload): number {
  const id = objectValue(payload.installation)?.id;
  if (typeof id !== "number") throw new Error("Invalid installation metadata");
  return id;
}

function registeredRepository(
  value: unknown,
  installationId: number,
  accountLogin: string | null,
): RepositoryRecord | null {
  const repository = objectValue(value);
  if (repository === null || typeof repository.id !== "number") return null;

  const fullName = stringValue(repository.full_name);
  const owner = stringValue(objectValue(repository.owner)?.login) ??
    stringValue(fullName?.split("/")[0]) ?? accountLogin;
  const name = stringValue(repository.name) ??
    stringValue(fullName?.split("/").slice(1).join("/"));
  const defaultBranch = stringValue(repository.default_branch);
  if (owner === null || name === null || defaultBranch === null) return null;

  return {
    id: repository.id,
    installationId,
    owner,
    repo: name,
    defaultBranch,
    suspended: false,
  };
}

async function reconcileInstallationRepositories(
  deps: HandlerDeps,
  id: number,
  accountLogin: string | null,
): Promise<void> {
  const client = await deps.getInstallationClient(id);
  const values: unknown[] = [];
  for (let page = 1;; page++) {
    const { data } = await client.request<{ repositories: unknown[] }>(
      "GET /installation/repositories",
      { per_page: 100, page },
    );
    if (!Array.isArray(data.repositories)) {
      throw new Error("Invalid installation repository listing");
    }
    values.push(...data.repositories);
    if (data.repositories.length < 100) break;
  }

  const records: RepositoryRecord[] = [];
  for (const value of values) {
    const record = registeredRepository(value, id, accountLogin);
    if (record === null) throw new Error("Invalid repository metadata");
    records.push(record);
  }

  const existing = await deps.registry.listRepositories(id);
  const existingById = new Map(existing.map((record) => [record.id, record]));
  const authoritativeIds = new Set(records.map((record) => record.id));
  for (const record of records) {
    await deps.registry.upsertRepository({
      ...record,
      suspended: existingById.get(record.id)?.suspended ?? false,
    });
  }
  for (const record of existing) {
    if (!authoritativeIds.has(record.id)) {
      await deps.registry.removeRepository(record.id);
    }
  }
}

async function updateInstallation(
  deps: HandlerDeps,
  payload: WebhookPayload,
): Promise<void> {
  const id = installationId(payload);
  const action = payload.action;

  if (action === "created") {
    const accountLogin = stringValue(
      objectValue(payload.installation)?.account
        ? objectValue(objectValue(payload.installation)?.account)?.login
        : null,
    );
    await reconcileInstallationRepositories(deps, id, accountLogin);
    return;
  }

  const repositories = await deps.registry.listRepositories(id);
  if (action === "deleted") {
    for (const repository of repositories) {
      await deps.registry.removeRepository(repository.id);
    }
  } else if (action === "suspend" || action === "unsuspend") {
    const suspended = action === "suspend";
    for (const repository of repositories) {
      await deps.registry.upsertRepository({ ...repository, suspended });
    }
  }
}

async function updateInstallationRepositories(
  deps: HandlerDeps,
  payload: WebhookPayload,
): Promise<void> {
  const id = installationId(payload);
  const accountLogin = stringValue(
    objectValue(objectValue(payload.installation)?.account)?.login,
  );

  if (payload.action !== "added" && payload.action !== "removed") return;
  await reconcileInstallationRepositories(deps, id, accountLogin);
}

async function processWithLease(
  deps: HandlerDeps,
  repository: RepositoryRecord,
  owner: string,
): Promise<RepositoryProcessingResult> {
  if (!await deps.registry.acquireLease(repository.id, owner, 60_000)) {
    return "busy";
  }

  try {
    const client = await deps.getInstallationClient(repository.installationId);
    await (deps.processRepository ?? processRepository)(
      repository,
      client,
      deps.env.configFilename,
    );
    return "processed";
  } finally {
    await deps.registry.releaseLease(repository.id, owner);
  }
}

async function dispatchRepositoryEvent(
  deps: HandlerDeps,
  event: string,
  delivery: string,
  payload: WebhookPayload,
): Promise<RepositoryProcessingResult> {
  if (event === "check_run" || event === "check_suite") {
    const check = objectValue(payload[event]);
    if (
      !Array.isArray(check?.pull_requests) || check.pull_requests.length === 0
    ) {
      return "processed";
    }
  }

  const repositoryId = objectValue(payload.repository)?.id;
  if (typeof repositoryId !== "number") return "processed";
  const repository = await deps.registry.getRepository(repositoryId);
  if (repository === null || repository.suspended) return "processed";

  return await processWithLease(deps, repository, delivery);
}

async function dispatchWebhook(
  deps: HandlerDeps,
  event: string,
  delivery: string,
  payload: WebhookPayload,
): Promise<RepositoryProcessingResult> {
  if (event === "installation") {
    await updateInstallation(deps, payload);
  } else if (event === "installation_repositories") {
    await updateInstallationRepositories(deps, payload);
  } else if (
    event === "push" || event === "pull_request" || event === "check_run" ||
    event === "check_suite" || event === "status"
  ) {
    return await dispatchRepositoryEvent(deps, event, delivery, payload);
  }
  return "processed";
}

export function createHandler(
  deps: HandlerDeps,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok" });
    }
    if (request.method !== "POST" || url.pathname !== "/api/github/webhooks") {
      return new Response("Not Found", { status: 404 });
    }

    const contentType = request.headers.get("content-type")
      ?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return jsonResponse({ status: "unsupported_content_type" }, 415);
    }

    const body = await request.text();
    if (
      !await verifyWebhookSignature(
        deps.env.webhookSecret,
        body,
        request.headers.get("x-hub-signature-256"),
      )
    ) {
      return jsonResponse({ status: "unauthorized" }, 401);
    }

    let webhook: ReturnType<typeof parseWebhook>;
    try {
      webhook = parseWebhook(
        body,
        request.headers.get("x-github-event"),
        request.headers.get("x-github-delivery"),
      );
    } catch {
      return jsonResponse({ status: "bad_request" }, 400);
    }

    try {
      if (await deps.registry.wasDeliveryProcessed(webhook.delivery)) {
        return jsonResponse({ status: "duplicate" });
      }

      let outcome: RepositoryProcessingResult = "processed";
      try {
        outcome = await dispatchWebhook(
          deps,
          webhook.event,
          webhook.delivery,
          webhook.payload,
        );
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
        log(
          deps,
          `Arshite configuration error acknowledged; delivery=${webhook.delivery}; event=${webhook.event}`,
        );
      }

      if (outcome === "busy") {
        return jsonResponse({ status: "busy" }, 503);
      }
      await deps.registry.markDeliveryProcessed(webhook.delivery);
      return jsonResponse({ status: "ok" });
    } catch {
      log(
        deps,
        `Arshite webhook processing failed; delivery=${webhook.delivery}; event=${webhook.event}`,
      );
      return jsonResponse({ status: "error" }, 500);
    }
  };
}

export async function processAllRepositories(deps: HandlerDeps): Promise<void> {
  const repositories = await deps.registry.listRepositories();
  for (const repository of repositories) {
    if (repository.suspended) continue;

    try {
      await processWithLease(
        deps,
        repository,
        `cron:${crypto.randomUUID()}`,
      );
    } catch {
      log(
        deps,
        `Arshite cron repository processing failed; repository=${repository.owner}/${repository.repo}`,
      );
    }
  }
}
