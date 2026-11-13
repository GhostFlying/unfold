# GitHub through gh

GitHub.com PRs use the native connector host's installed `gh` CLI and existing login. The Web/API container does not need gh or access to its credential files. Neither CLI clients nor the agent skill copy GitHub credentials to the server.

On the connector host:

```sh
gh auth login --hostname github.com
gh auth status --hostname github.com
unfold --json doctor
```

`doctor` reports `connector.providers.github` with availability, authentication, CLI version and account, or an actionable error. Only the owner can read it. Ensure the account/token can read the target repository; private repositories need appropriate access. Comment publication also needs permission to comment. Reuse the native login store; never put tokens in a PR URL, repository configuration, container image or plugin package.

## Common workflow

```sh
unfold --json import https://github.com/OWNER/REPO/pull/NUMBER/files
unfold --json show REVIEW_ID
unfold --json diff REVIEW_ID
unfold --json source REVIEW_ID src/example.ts --side old
unfold --json analyze REVIEW_ID --backend codex --wait
unfold --json ask REVIEW_ID --body '这里为什么先检查取消状态？' --wait
unfold --json guide REVIEW_ID
unfold --json share REVIEW_ID
```

Use any existing backend/model/effort setting or per-run option. The provider does not choose the agent. GitHub PR subpages, query parameters and fragments normalize to one canonical PR and durable review ID. CLI, Web and the post-submission skill use the same service. Existing execution approval, private conversation and visitor restrictions apply to both providers.

## Versions and limits

The connector reads the PR's base tip and head, then compares those **immutable SHAs** and uses GitHub's merge-base commit as the old side. It rechecks the PR's head/base and changed-file count after fetching the comparison and discussions. Drift rejects that import/refresh rather than mixing revisions. Pinned Git tree/blob reads support fork PR objects available in the base repository. A deleted or inaccessible Git object returns an error; no mutable branch fallback is used.

The [GitHub compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits) returns at most 300 changed files. Unfold rejects PRs beyond this limit and count mismatches, with `github_diff_limit` / `github_diff_incomplete`. Missing or incomplete patches are marked unavailable for inline positioning; binary status is not inferred from an omitted patch. Tree listings must be complete. Source is limited to regular UTF-8 files up to 1 MB; symlinks, submodules, binary blobs and LFS pointers are rejected. Discussions paginate up to a bounded 10,000 items per endpoint and fail explicitly if incomplete. A native subprocess has bounded output and duration. Explicit HTTP 502/503/504 read failures retry at most twice with short backoff. Writes are sent once and never participate in that retry path.

Only github.com is supported by this adapter. GitHub Enterprise configuration is not included. GitHub authentication errors use `github_auth_required` (CLI exit 6); permission/rate-limit failures and unavailable resources retain distinct error codes. An HTTP 404 can also mean the logged-in account cannot access a private repository.

## Path owners

New analyses capture [CODEOWNERS declarations](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) from the pinned PR target tip, independently of the diff merge base and fork/head rules. Location precedence is `.github/CODEOWNERS`, `CODEOWNERS`, then `docs/CODEOWNERS`; the first existing file wins. Matching is case-sensitive, the last matching rule wins, and a rule without owners clears ownership. Invalid patterns are skipped with warnings. Team names are not expanded, and declaration matching does not prove account permissions or review requests.

Both old and new paths participate in a renamed file's reading scope. The saved rule revision and capture time are part of each explanation, so a later rule refresh cannot change an existing scoped share. Use `owners`, `guide --owner` / `--path`, and `share --owner` / `--path` through the same CLI/API as Codebase. Missing rules leave path-based review available. See [CLI scopes](cli.md#modules-and-reading-scopes).

## Deliberate comments

Ordinary PR comments, submitted review bodies, inline comments and replies refresh from GitHub. Pending reviews and their unpublished comments are excluded. The original platform remains authoritative for discussion state.

Create/edit a draft, inspect `draft preview`, then publish with the exact digest:

```sh
unfold --json reference REVIEW_ID src/example.ts --start 42
unfold --json draft create REVIEW_ID --reference REFERENCE_ID --body-file comment.md
unfold --json draft preview DRAFT_ID
unfold --json draft publish DRAFT_ID --confirm EXACT_PREVIEW_DIGEST
```

General comments use the issue-comment endpoint. [Native review comments](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request) pin `commit_id` to the reviewed head, the canonical changed-file path, `LEFT`/`RIGHT` and the exact line range. Rename/deletion references preserve their old source path while publication uses GitHub's changed-file path. Unfold never submits an existing pending review or bulk-publishes native drafts.

GitHub drafts do not automatically append the company-network explanation URL to a potentially public PR. The share command and skill return it separately for the owner's authorized review handoff. Drafts still include their independently readable body, reviewed revision, original PR URL and any source position.

The common service refreshes the version before publication, rechecks the draft digest after that read, and records each result separately. A PR can still change after preflight; inline publication remains pinned to the reviewed commit and can become outdated. General comments include the reviewed revision in their body. Transport errors retain `unknown`; use `draft reconcile DRAFT_ID` to look for the original publication marker, without automatically posting again. Merely preparing a share link never creates a GitHub comment or group notification.
