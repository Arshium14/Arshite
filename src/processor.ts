import { canMerge } from "./merge.ts";
import type { MergePullRequest } from "./merge.ts";
import { parseRulesDocument } from "./rules.ts";
import type { GitHubClient, RepositoryRecord, Rule } from "./types.ts";

interface ContentResponse {
  content: string;
  encoding: string;
}

interface CompareResponse {
  ahead_by: number;
}

interface GitRefResponse {
  object?: { sha?: string };
}

interface RepositoryIdentity {
  name: string;
  owner: { login: string };
}

interface RepositoryMetadata extends RepositoryIdentity {
  parent?: RepositoryIdentity | null;
  source?: RepositoryIdentity | null;
}

interface PullRequest extends MergePullRequest {
  number: number;
  mergeable: boolean | null;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  requested_reviewers: Array<{ login: string }>;
}

const routes = {
  contents: "GET /repos/{owner}/{repo}/contents/{path}",
  compare: "GET /repos/{owner}/{repo}/compare/{basehead}",
  listPulls: "GET /repos/{owner}/{repo}/pulls",
  createPull: "POST /repos/{owner}/{repo}/pulls",
  repository: "GET /repos/{owner}/{repo}",
  getPull: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
  labels: "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
  deleteLabel:
    "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
  assignees: "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees",
  reviewers:
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  merge: "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
  reset: "PATCH /repos/{owner}/{repo}/git/refs/heads/{ref}",
  upstreamRef: "GET /repos/{owner}/{repo}/git/ref/heads/{ref}",
} as const;

export class ConfigurationError extends Error {
  constructor(repository: RepositoryRecord) {
    super(
      `Invalid Arshite configuration for ${repository.owner}/${repository.repo}.`,
    );
    this.name = "ConfigurationError";
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  return typeof error.status === "number" ? error.status : undefined;
}

function decodeContent(content: string): string {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function missingLogins(
  configured: string[],
  existing: Array<{ login: string }>,
): string[] {
  const present = new Set(existing.map(({ login }) => login));
  return [...new Set(configured)].filter((login) => !present.has(login));
}

function upstreamRepositoryName(
  metadata: RepositoryMetadata,
  upstreamOwner: string,
): string | undefined {
  const upstream = [metadata.parent, metadata.source].find((candidate) =>
    candidate?.owner.login === upstreamOwner
  );
  if (upstream) return upstream.name;
  if (metadata.owner.login === upstreamOwner) return metadata.name;
  return undefined;
}

export async function processRule(
  repository: RepositoryRecord,
  rule: Rule,
  client: GitHubClient,
): Promise<void> {
  const repositoryParameters = {
    owner: repository.owner,
    repo: repository.repo,
  };
  let comparison: CompareResponse;
  try {
    const response = await client.request<CompareResponse>(routes.compare, {
      ...repositoryParameters,
      basehead: `${rule.base}...${rule.upstream}`,
    });
    comparison = response.data;
  } catch (error) {
    const status = statusOf(error);
    if (status !== 404 && status !== 422) throw error;
    console.error(
      `Arshite upstream comparison skipped; repository=${repository.owner}/${repository.repo}; base=${rule.base}; upstream=${rule.upstream}; status=${status}`,
    );
    return;
  }

  if (comparison.ahead_by === 0) return;
  const upstreamOwner = rule.upstream.split(":", 1)[0];

  if (rule.autoMerge && rule.mergeMethod === "hardreset") {
    const { data: metadata } = await client.request<RepositoryMetadata>(
      routes.repository,
      repositoryParameters,
    );
    const upstreamRepo = upstreamRepositoryName(metadata, upstreamOwner);
    if (!upstreamRepo) return;
    const { data: upstreamRef } = await client.request<GitRefResponse>(
      routes.upstreamRef,
      {
        owner: upstreamOwner,
        repo: upstreamRepo,
        ref: rule.upstream.slice(upstreamOwner.length + 1),
      },
    );
    const upstreamSha = upstreamRef.object?.sha;
    if (!upstreamSha) return;
    await client.request(routes.reset, {
      ...repositoryParameters,
      ref: rule.base,
      sha: upstreamSha,
      force: true,
    });
    return;
  }

  const { data: pullRequests } = await client.request<PullRequest[]>(
    routes.listPulls,
    {
      ...repositoryParameters,
      state: "open",
      head: rule.upstream,
      base: rule.base,
    },
  );

  let selected = pullRequests[0];
  if (!selected) {
    const { data: metadata } = await client.request<RepositoryMetadata>(
      routes.repository,
      repositoryParameters,
    );
    const headRepo = upstreamRepositoryName(metadata, upstreamOwner);
    const { data: created } = await client.request<PullRequest>(
      routes.createPull,
      {
        ...repositoryParameters,
        title: `Sync ${rule.upstream} into ${rule.base}`,
        head: rule.upstream,
        base: rule.base,
        body:
          `Upstream synchronization from ${rule.upstream} into ${rule.base}.\n\nSource rule: ${rule.upstream} -> ${rule.base}.`,
        ...(headRepo === undefined ? {} : { head_repo: headRepo }),
      },
    );
    selected = created;
  }

  const pullParameters = {
    ...repositoryParameters,
    pull_number: selected.number,
  };
  const { data: pull } = await client.request<PullRequest>(
    routes.getPull,
    pullParameters,
  );
  const hasConflict = pull.mergeable === false ||
    pull.mergeable_state === "dirty";
  const hasKnownNonConflict = pull.mergeable === true && !hasConflict &&
    pull.mergeable_state !== "unknown";
  const labels = new Set(pull.labels.map(({ name }) => name));
  const issueParameters = {
    ...repositoryParameters,
    issue_number: pull.number,
  };

  if (!labels.has(rule.label)) {
    await client.request(routes.labels, {
      ...issueParameters,
      labels: [rule.label],
    });
    labels.add(rule.label);
  }

  if (hasConflict) {
    if (!labels.has(rule.conflictLabel)) {
      await client.request(routes.labels, {
        ...issueParameters,
        labels: [rule.conflictLabel],
      });
      labels.add(rule.conflictLabel);
    }
  } else if (
    hasKnownNonConflict && rule.label !== rule.conflictLabel &&
    labels.has(rule.conflictLabel)
  ) {
    try {
      await client.request(routes.deleteLabel, {
        ...issueParameters,
        name: rule.conflictLabel,
      });
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }

  const assignees = missingLogins(rule.assignees, pull.assignees);
  if (assignees.length > 0) {
    await client.request(routes.assignees, {
      ...issueParameters,
      assignees,
    });
  }

  const configuredReviewers = hasConflict
    ? [...rule.reviewers, ...rule.conflictReviewers]
    : rule.reviewers;
  const reviewers = missingLogins(
    configuredReviewers,
    pull.requested_reviewers,
  );
  if (reviewers.length > 0) {
    await client.request(routes.reviewers, {
      ...pullParameters,
      reviewers,
    });
  }

  if (
    !rule.autoMerge || rule.mergeMethod === "none" ||
    rule.mergeMethod === "hardreset"
  ) {
    return;
  }

  const { data: freshPull } = await client.request<PullRequest>(
    routes.getPull,
    pullParameters,
  );
  if (!canMerge(freshPull, rule)) return;

  try {
    await client.request(routes.merge, {
      ...pullParameters,
      merge_method: rule.mergeMethod,
      sha: freshPull.head.sha,
    });
  } catch (error) {
    const status = statusOf(error);
    if (status !== 405 && status !== 409 && status !== 422) throw error;
    console.error(
      `Arshite merge rejected for ${repository.owner}/${repository.repo}#${pull.number}; status=${status}`,
    );
  }
}

export async function processRepository(
  repository: RepositoryRecord,
  client: GitHubClient,
  configFilename: string,
): Promise<void> {
  let content: ContentResponse;
  try {
    const response = await client.request<ContentResponse>(routes.contents, {
      owner: repository.owner,
      repo: repository.repo,
      path: `.github/${configFilename}`,
      ref: repository.defaultBranch,
    });
    content = response.data;
  } catch (error) {
    if (statusOf(error) === 404) return;
    throw error;
  }

  let document: ReturnType<typeof parseRulesDocument>;
  try {
    document = parseRulesDocument(decodeContent(content.content));
  } catch {
    throw new ConfigurationError(repository);
  }

  for (const issue of document.issues) {
    console.error(
      `Arshite rule configuration skipped; repository=${repository.owner}/${repository.repo}; rule=${issue.index}`,
    );
  }
  for (const { rule } of document.rules) {
    await processRule(repository, rule, client);
  }
}
