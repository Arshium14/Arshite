export type MergeMethod = "none" | "merge" | "squash" | "rebase" | "hardreset";

export interface Rule {
  base: string;
  upstream: string;
  mergeMethod: MergeMethod;
  autoMerge: boolean;
  mergeUnstable: boolean;
  label: string;
  conflictLabel: string;
  assignees: string[];
  reviewers: string[];
  conflictReviewers: string[];
}

export interface RepositoryRecord {
  id: number;
  installationId: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  suspended: boolean;
}

export interface GitHubClient {
  request<T>(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: T }>;
}

export interface AppEnv {
  appId: string;
  appSlug: string;
  webhookSecret: string;
  privateKey: string;
  configFilename: string;
  logLevel: string;
}
