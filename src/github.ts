import { App } from "@octokit/app";
import { Octokit } from "octokit";
import type { AppEnv, GitHubClient } from "./types.ts";

export interface GitHubApp {
  getInstallationClient(installationId: number): Promise<GitHubClient>;
}

export function createGitHubApp(env: AppEnv): GitHubApp {
  const app = new App({
    appId: env.appId,
    privateKey: env.privateKey,
    Octokit,
  });

  return {
    async getInstallationClient(installationId) {
      const octokit = await app.getInstallationOctokit(installationId);
      return {
        async request<T>(
          route: string,
          parameters?: Record<string, unknown>,
        ): Promise<{ data: T }> {
          const response = await octokit.request(route, parameters);
          return { data: response.data as T };
        },
      };
    },
  };
}
