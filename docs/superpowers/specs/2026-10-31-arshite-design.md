# Arshite Design

## Purpose

Arshite is a self-hosted GitHub App inspired by wei/pull. It keeps fork branches synchronized with upstream repositories through pull requests and adds conservative, configurable pull-request automation. It runs on Deno Deploy without a local server, MongoDB, or Redis.

## Scope

Version 1 supports:

- GitHub App installation and repository registration.
- Scheduled and webhook-triggered upstream synchronization.
- Pull-compatible `.github/pull.yml` rules.
- Creating and updating upstream-sync pull requests.
- Labels, assignees, reviewers, conflict labels, and conflict reviewers.
- Opt-in merging after GitHub reports that required checks and reviews are satisfied.
- Explicitly configured hard resets.
- Deno KV persistence for installation records, idempotency, and leases.
- Health checks, structured logs, tests, and deployment configuration.

Version 1 does not include a web dashboard, public unauthenticated trigger endpoints, AI review features, or arbitrary PR commands.

## Runtime Architecture

A single Deno TypeScript application serves HTTPS webhooks and registers one Deno cron job. Octokit authenticates as the GitHub App and creates per-installation clients.

Components:

- `src/main.ts`: HTTP entry point, health endpoint, webhook routing, and cron registration.
- `src/env.ts`: runtime environment parsing and private-key decoding.
- `src/webhooks.ts`: signature verification and event dispatch.
- `src/registry.ts`: installations, repositories, delivery deduplication, and repository leases in Deno KV.
- `src/rules.ts`: YAML loading and strict rule validation.
- `src/github.ts`: Octokit construction and GitHub API helpers.
- `src/processor.ts`: synchronization, PR automation, merge guards, and hard-reset behavior.

Deno KV contains installation/repository metadata, processed delivery IDs, and expiring leases. It does not contain GitHub credentials, repository source, pull-request state, or user configuration. GitHub remains authoritative for branches and pull requests.

## Configuration

Arshite reads `.github/pull.yml` from each repository's default branch:

```yaml
version: "1"
rules:
  - base: main
    upstream: upstream-owner:main
    mergeMethod: merge
    autoMerge: false
    mergeUnstable: false
    label: upstream-sync
    conflictLabel: merge-conflict
    assignees: []
    reviewers: []
    conflictReviewers: []
```

Rules:

- `version` must be the string `"1"`.
- `base` is a branch in the installed repository.
- `upstream` is `owner:branch` in the same fork network.
- `mergeMethod` is `none`, `merge`, `squash`, `rebase`, or `hardreset`; default `none`.
- `autoMerge` defaults to `false`. Arshite never merges or resets a branch unless it is `true`.
- `autoMerge: true` requires a merge method other than `none`.
- `mergeUnstable` defaults to `false` and permits merging only GitHub's `unstable` state in addition to `clean`.
- `label` defaults to `upstream-sync`; `conflictLabel` defaults to `merge-conflict`.
- Assignee and reviewer entries are GitHub logins without `@`.

Unknown config keys are rejected so misspelled safety settings cannot silently change behavior. Invalid rules are logged and skipped without affecting other repositories.

## Synchronization Flow

For each active repository, the processor acquires a short expiring KV lease. Cron and webhook processing therefore cannot mutate the same repository concurrently. Operations remain idempotent if a lease expires or GitHub retries a delivery.

For each rule:

1. Resolve the base and upstream branches.
2. Compare the base with the upstream head. Stop when the base is already up to date.
3. For `autoMerge: true` plus `mergeMethod: hardreset`, update the base ref directly to the upstream head and skip PR creation. This combination is the only hard-reset path and is never a fallback for conflicts or failed merges.
4. Otherwise, find an open PR with the same upstream head and base. Reuse it instead of creating a duplicate.
5. If absent, create a PR titled `Sync <upstream> into <base>` with a concise explanation and source rule.
6. Ensure the configured label and assignees are present. Request only reviewers not already requested.
7. When GitHub reports conflicts, apply the conflict label and request conflict reviewers. Remove Arshite's conflict label after conflicts clear; do not remove unrelated labels or reviewers.
8. Evaluate auto-merge only when `autoMerge` is true, the PR is open and non-draft, and its head still matches the configured upstream branch.

## Merge Safety

For normal PR merges, Arshite rereads the PR immediately before merging. It merges only when `mergeable_state` is `clean`, or `unstable` with `mergeUnstable: true`. States including `draft`, `blocked`, `dirty`, `behind`, and `unknown` do not merge.

This delegates required status checks, required reviews, branch protection, and merge restrictions to GitHub. Arshite does not infer eligibility from individual check events. If GitHub rejects a merge because protection changed, Arshite logs the result and leaves the PR open.

## Event Handling

- `installation` and `installation_repositories`: add, update, suspend, or remove registry records.
- `push`: process the repository after relevant branch or configuration changes.
- `pull_request`: reevaluate automation and merge eligibility.
- `check_run`, `check_suite`, and `status`: reevaluate open PRs associated with the commit.
- Other valid events receive a successful ignored response.

The webhook secret is verified with HMAC-SHA256 before JSON parsing. Invalid signatures, missing delivery IDs, malformed JSON, and unsupported content receive appropriate 4xx responses. Successfully processed delivery IDs are retained temporarily to suppress retries.

## Error Handling and Observability

- Configuration errors fail only the affected rule.
- Missing upstream branches or inaccessible private upstream repositories are logged without retry storms.
- Cron processes repositories independently; one failure does not stop the batch.
- Transient GitHub/network failures use bounded Octokit retries and are logged.
- Webhook processing failures return 500 so GitHub can retry; validation and configuration failures do not request retries.
- Logs include delivery ID, repository, rule, and action, but never private keys, webhook secrets, tokens, or config file contents.
- `GET /health` returns a minimal status response without environment details.

## GitHub App Settings

The app is named `Arshite` with webhook path `/api/github/webhooks`.

Permissions:

- Repository metadata: read.
- Contents: read/write.
- Pull requests: read/write.
- Issues: read/write for labels and assignees.
- Checks: read.
- Commit statuses: read.

Events:

- Installation and installation repositories.
- Push.
- Pull request.
- Check run and check suite.
- Status.

## Testing

Deno tests cover:

- Valid and invalid rule parsing, especially auto-merge defaults and unknown keys.
- Webhook signature acceptance and rejection.
- Registry add/remove behavior, delivery deduplication, and lease contention using ephemeral KV.
- PR creation versus reuse, upstream comparisons, labels, assignees, reviewers, and conflict transitions.
- Every mergeable-state decision and the hard-reset opt-in guard.
- Webhook-to-processing integration with mocked GitHub clients.
- Cron batch isolation when one repository fails.

Verification includes `deno fmt --check`, `deno lint`, `deno check`, and `deno test`. Real GitHub behavior requires registering a test app and is documented as a manual deployment check rather than claimed by mocked tests.

## Deployment

Deno Deploy environment variables:

- `APP_ID`
- `APP_SLUG=arshite`
- `PRIVATE_KEY` or `PRIVATE_KEY_BASE64`
- `WEBHOOK_SECRET`
- Optional `CONFIG_FILENAME=pull.yml`
- Optional `LOG_LEVEL=info`

A single cron job runs every 15 minutes. Deno Deploy prevents overlapping cron invocations; KV leases additionally isolate webhook and cron work. The free plan is suitable for low-volume use subject to its current request, CPU, KV, and cron limits.
