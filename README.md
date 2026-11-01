# Arshite

Arshite is a self-hosted GitHub App inspired by
[`wei/pull`](https://github.com/wei/pull). It keeps fork branches synchronized
with upstream repositories through pull requests and adds conservative,
configurable pull-request automation. The service runs on Deno Deploy with Deno
KV; it does not require MongoDB, Redis, a dashboard, or a separate worker.

Arshite responds to installation, repository, pull-request, and check-related
webhooks. It also runs one cron job every 15 minutes. GitHub remains
authoritative for branches, pull requests, checks, reviews, and branch
protection.

## Prerequisites

- Deno 2.9 or newer for local formatting, linting, type checking, tests, and
  development.
- A GitHub account with permission to create a GitHub App and install it on the
  forks you want to synchronize. This is needed only for real deployment and
  manual testing, not for the automated test suite.
- A Deno Deploy account and a repository that can be connected through Deno
  Deploy's Git integration for deployment.

## Local checks

Run these commands from the repository root. The tasks in `deno.json` limit
formatting, linting, and test discovery to the active application; archived SDD
snapshots and design scratch files are excluded.

```sh
deno task fmt       # Format active source, tests, deno.json, and this README
deno task fmt:check # Check formatting without changing files
deno task lint      # Lint active source and tests
deno task check     # Type-check the production entry point and every active test
deno task test      # Run every test in tests/
deno task verify    # Run fmt:check, lint, check, and test in sequence
```

The equivalent required full verification sequence is:

```sh
deno fmt --check && deno lint && deno check --unstable-kv --unstable-cron src/main.ts tests/*.ts && deno test --unstable-kv --allow-env tests/
```

For local development, copy `.env.example` to `.env`, replace every placeholder
with your own app settings, and run:

```sh
deno task dev
```

The development task loads `.env`, starts the HTTP server and cron locally, and
uses local Deno KV. With real credentials and a reachable webhook URL, local
development can perform real GitHub actions; use a test app and disposable
forks. Do not commit `.env`.

### Automated-test boundary

Local and automated tests use mocked GitHub APIs and in-memory Deno KV. They do
not register a GitHub App, deploy to Deno Deploy, contact real repositories, or
validate real app credentials, webhook delivery, branch protection, or
production cron behavior. Building, formatting, linting, type checking, and
testing do not perform deployment or registration.

## Create the GitHub App

Create a GitHub App named **Arshite** in your account or organization settings.
GitHub normally derives the required slug `arshite` from that name; `APP_SLUG`
must be exactly `arshite`.

Configure the webhook as follows:

- **Webhook URL:** your deployed HTTPS origin plus `/api/github/webhooks`, for
  example `https://arshite.example.deno.net/api/github/webhooks`. If the origin
  is not known yet, update this field immediately after the first deployment.
- **Webhook secret:** a strong random value identical to the deployed
  `WEBHOOK_SECRET` environment variable.
- **Content type:** `application/json`.
- **Webhook:** active.

Select exactly these six repository permissions:

| Permission      | Access     | Why Arshite needs it                                                                      |
| --------------- | ---------- | ----------------------------------------------------------------------------------------- |
| Metadata        | Read       | Repository and installation metadata.                                                     |
| Contents        | Read/write | Read `.github/pull.yml` and update a branch only for an explicitly configured hard reset. |
| Pull requests   | Read/write | Find, create, inspect, request reviewers for, and merge synchronization PRs.              |
| Issues          | Read/write | Apply/remove labels and manage assignees on pull requests.                                |
| Checks          | Read       | React to associated check-run and check-suite events.                                     |
| Commit statuses | Read       | React to commit-status events.                                                            |

Subscribe to these seven events:

1. Installation
2. Installation repositories
3. Push
4. Pull request
5. Check run
6. Check suite
7. Status

Generate a private key for the app. Keep the downloaded PEM file secret and
never commit it. In Deno Deploy, configure either:

- `PRIVATE_KEY` as the complete multiline PEM value; or
- `PRIVATE_KEY_BASE64` as the base64 encoding of the complete PEM file.

Set only one private-key variable. If both are present, Arshite uses
`PRIVATE_KEY`.

## Deploy to Deno Deploy

1. Push the application to a repository you control. Do not include `.env` or
   the private key.
2. In Deno Deploy, create a project using the Git integration and select that
   repository.
3. Set the entry point to `src/main.ts` and deploy it. In the app's
   **Databases** tab, create or attach a KV database; `Deno.openKv()` fails and
   the deployment cannot start until one is attached.
4. Configure all of these environment variables in the Deno Deploy project:

   | Variable                              | Value                                                               |
   | ------------------------------------- | ------------------------------------------------------------------- |
   | `APP_ID`                              | The numeric GitHub App ID.                                          |
   | `APP_SLUG`                            | `arshite`                                                           |
   | `PRIVATE_KEY` or `PRIVATE_KEY_BASE64` | The generated private key in exactly one of the supported forms.    |
   | `WEBHOOK_SECRET`                      | The same strong random secret configured on the GitHub App webhook. |
   | `CONFIG_FILENAME`                     | `pull.yml` (the default).                                           |
   | `LOG_LEVEL`                           | `info` (the default).                                               |

5. Redeploy if your Deno Deploy workflow requires it after environment changes,
   then copy the deployed HTTPS origin into the GitHub App webhook URL as
   `https://<origin>/api/github/webhooks`.
6. Install the app on each fork you want Arshite to manage and grant access to
   those repositories. Add a `.github/pull.yml` file to each fork's default
   branch as described below.

The KV database attached in the app's **Databases** tab backs `Deno.openKv()`;
create or attach it before expecting a successful deployment. `src/main.ts`
registers one cron named `Arshite repository sync` on the `*/15 * * * *`
schedule, so it runs every 15 minutes. Deno Deploy free-tier request, CPU, KV,
and cron limits apply; review the current limits before production use.

## Repository configuration

Arshite reads `.github/pull.yml` from the default branch of each installed
repository. Set `CONFIG_FILENAME` only if you need a different filename beneath
`.github/`.

This complete example includes every supported field with safe defaults. It
creates or updates synchronization PRs but never merges or resets a branch
automatically:

```yaml
version: "1"
rules:
  - base: main
    upstream: upstream-owner:main
    mergeMethod: none
    autoMerge: false
    mergeUnstable: false
    label: upstream-sync
    conflictLabel: merge-conflict
    assignees: []
    reviewers: []
    conflictReviewers: []
```

### Field reference

| Field               | Meaning                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`           | Required and must be the string `"1"`.                                                                                                                |
| `rules`             | Required array of synchronization rules. Rules are processed sequentially.                                                                            |
| `base`              | Required branch in the installed fork that receives upstream changes.                                                                                 |
| `upstream`          | Required `owner:branch` reference in the same GitHub fork network, such as `upstream-owner:main`.                                                     |
| `mergeMethod`       | `none` (default), `merge`, `squash`, `rebase`, or `hardreset`. `none` disables PR merging.                                                            |
| `autoMerge`         | Defaults to `false`. Must be `true` for any automatic merge or hard reset. `true` requires a method other than `none`.                                |
| `mergeUnstable`     | Defaults to `false`. When `true`, a normal PR merge may also proceed when GitHub reports `mergeable_state` as `unstable`; this is an explicit opt-in. |
| `label`             | Label applied to synchronization PRs; defaults to `upstream-sync`.                                                                                    |
| `conflictLabel`     | Label applied while GitHub reports conflicts and removed after they clear; defaults to `merge-conflict`.                                              |
| `assignees`         | GitHub logins to add as PR assignees. Defaults to `[]`; omit `@`.                                                                                     |
| `reviewers`         | GitHub logins to request as reviewers. Defaults to `[]`; omit `@`.                                                                                    |
| `conflictReviewers` | Additional GitHub logins requested only while the PR has conflicts. Defaults to `[]`; omit `@`.                                                       |

Unknown keys, missing required fields, malformed upstream references, and
invalid safety-setting combinations are rejected rather than silently ignored.

### Synchronization and merge behavior

For each rule, Arshite compares `base` with `upstream` and stops if the base is
already up to date. Otherwise, it normally reuses the matching open
upstream-sync PR or creates one, then ensures the configured labels, assignees,
and reviewer requests are present. Conflict automation adds only the configured
conflict label and conflict reviewers; clearing conflicts removes only that
conflict label.

Normal automatic merging requires all of the following:

- `autoMerge: true` and `mergeMethod` set to `merge`, `squash`, or `rebase`.
- An open, non-draft PR whose head still exactly matches the configured
  upstream.
- An immediate reread from GitHub reporting `mergeable_state` as `clean`, or
  `unstable` only when `mergeUnstable: true`.

Required checks, required reviews, branch protection, and final merge
eligibility are delegated to GitHub. Arshite does not infer eligibility from
individual check events, and a GitHub merge rejection leaves the PR open.
Enabling `mergeUnstable` does not bypass GitHub's required-check or review
enforcement.

A hard reset is destructive and occurs **only** for the exact combination:

```yaml
autoMerge: true
mergeMethod: hardreset
```

That combination force-updates the base branch to the compared upstream head and
creates no PR. `mergeMethod: hardreset` without `autoMerge: true` follows the
safe PR-only path: it neither resets the branch nor merges the PR. Hard reset is
never used as a fallback for conflicts or failed merges.

## Post-deployment verification

1. Check the health endpoint:

   ```sh
   curl https://<your-deployed-origin>/health
   ```

   Expect HTTP 200 with:

   ```json
   { "status": "ok" }
   ```

2. In the GitHub App settings, open **Advanced** / **Recent deliveries**.
   Inspect installation and repository deliveries, confirm that requests reach
   `/api/github/webhooks`, and check for HTTP 200 responses such as
   `{"status":"ok"}` (or `{"status":"duplicate"}` for an already processed
   retry). Investigate 4xx signature/content/metadata errors and 5xx processing
   errors in Deno Deploy logs without exposing secrets.
3. On a disposable test fork with safe defaults (`autoMerge: false`), install or
   update the app installation and commit `.github/pull.yml` to the default
   branch. Confirm the installation webhook succeeds and the repository becomes
   registered.
4. Create a small upstream change, then push a relevant change or wait for the
   next 15-minute cron run. Confirm that Arshite creates one PR with the
   expected base/upstream and label, and that another run reuses it rather than
   creating a duplicate.
5. Confirm the safe defaults do not merge or reset anything. Test
   assignees/reviewers and conflict labels if configured. Exercise auto-merge or
   hard reset only in a separate disposable repository with explicit opt-in and
   a careful review of the destructive behavior.
6. Recheck Recent deliveries and Deno Deploy logs after each test. A passing
   automated suite is not a substitute for these real-app checks.
