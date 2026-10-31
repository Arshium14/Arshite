import { loadEnv } from "./env.ts";
import { createGitHubApp } from "./github.ts";
import {
  createHandler,
  type HandlerDeps,
  processAllRepositories,
} from "./handler.ts";
import { Registry } from "./registry.ts";

const env = loadEnv(Deno.env.toObject());
const kv = await Deno.openKv();
const registry = new Registry(kv);
const github = createGitHubApp(env);
const deps: HandlerDeps = {
  env,
  registry,
  getInstallationClient: github.getInstallationClient,
};

Deno.cron(
  "Arshite repository sync",
  "*/15 * * * *",
  { backoffSchedule: [60_000, 300_000] },
  () => processAllRepositories(deps),
);

Deno.serve(createHandler(deps));
