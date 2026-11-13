# CLI contract

Run `pnpm unfold --help`, or build and invoke `node bin/unfold.mjs` / link the executable locally. Global options are `--json`, `--server URL`, and `--token-file FILE`. Source host configuration is explicit; there is no arbitrary URL fetch endpoint.

| Operation                                | Command                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialize local configuration           | `init --codebase-host HOST [--share-base-url URL] [--share-bind ADDRESS]`                                                                      |
| Run HTTP service / native connector      | `serve` / `connector`                                                                                                                          |
| Diagnose CLI availability                | `doctor`                                                                                                                                       |
| Print owner key explicitly               | `auth token`                                                                                                                                   |
| Read / change shared configuration       | `config show`, `config set KEY JSON_VALUE`, `config status`, `config apply`                                                                    |
| Import / list / read / refresh           | `import URL [--backend traex\|codex]`, `list`, `show REVIEW`, `refresh REVIEW`                                                                 |
| Change per-review backend                | `backend REVIEW traex\|codex`                                                                                                                  |
| Generate / ask                           | `analyze REVIEW [--backend NAME] [--wait]`, `ask REVIEW --body TEXT [--reference ID] [--explanation ID] [--wait]`                              |
| Observe / stop                           | `runs REVIEW`, `run RUN`, `watch RUN`, `cancel RUN`                                                                                            |
| Read the globally active agent operation | `activity`                                                                                                                                  |
| Read source and revisions                | `diff REVIEW [--path PATH]`, `source REVIEW PATH --version ID [--side old\|new]`, `versions REVIEW`, `history REVIEW`                          |
| Select source context                    | `reference REVIEW PATH --version ID --start N [--end N] [--side old\|new]`                                                                     |
| Export / open / share                    | `export REVIEW --output FILE [--explanation ID]`, `open REVIEW`, `share REVIEW [--explanation ID]`                                             |
| Read / create / edit drafts              | `draft list REVIEW`, `draft show ID`, `draft create REVIEW --body TEXT [--reference ID]`, `draft edit ID --revision N --body TEXT [--general]` |
| Preview / publish / reconcile            | `draft preview ID`, `draft publish ID --confirm DIGEST`, `draft reconcile ID`                                                                  |
| Inspect / decide exact execution request | `approval list`, `approval approve ID --confirm DIGEST`, `approval deny ID --confirm DIGEST`                                                   |

`ask`, `draft create` and `draft edit` accept `--body-file FILE` or `--body-file -` instead of `--body`. No mutation occurs automatically after a preview. There is no blanket `--yes` for publishing or execution. A body/position/version change invalidates the confirmation digest.

JSON success with `--json`: `{"ok":true,"data":...}`. `review-summary` defaults to paste-ready plain text; other commands keep their existing JSON envelope. Errors go to stderr as `{"ok":false,"error":{"code":"...","message":"...","details":...}}`. IDs are durable service IDs, not native backend session IDs. Provider thread IDs in owner run metadata are private and are excluded from shared explanation records.

| Exit | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Operation succeeded, or a background operation was accepted; inspect its state |
| 1    | Operation failed / interrupted                                                 |
| 2    | Invalid CLI/configuration input                                                |
| 3    | Exact confirmation or execution approval required                              |
| 4    | Version, draft, or operation conflict                                          |
| 5    | Publication outcome unknown; reconcile, do not retry                           |
| 7    | Settings were saved but application failed or could not be confirmed           |
| 6    | Authentication required                                                        |

`analyze` and `ask` without `--wait` return a run ID immediately. With `--wait`, the CLI observes SSE until success, failure, interruption or a pending execution approval. Exit 3 carries the run ID; inspect `approval list`, decide the exact request and call `watch RUN`. Disconnecting the observer does not cancel a run. `cancel RUN` is explicit. An unknown publication remains blocked until a successful readback identifies the original comment; it is not implicitly reset to a fresh draft.

Saved settings apply automatically. An idle connector validates and installs changed connection settings online; active investigations, approval waits and publications retain their existing runtime until they finish. `config status` reports `applied`, `pending`, `applying`, `failed` or `unavailable`, with desired/applied revision IDs. `config apply` retries a saved configuration after a failed check. A failed application blocks new native work instead of silently using an older connection. Authentication files are never returned to the generated page or written to the source tree. Keep runtime configuration and receipts under `.local/`.

### Models and thinking effort

```sh
unfold --json agent models traex
unfold --json agent models codex
unfold agent defaults traex --model MODEL_FROM_CATALOG --effort high
unfold agent defaults codex --model MODEL_FROM_CATALOG --effort medium
unfold agent show REVIEW_ID
unfold agent set REVIEW_ID --backend traex --model MODEL_FROM_CATALOG --effort high
unfold agent set REVIEW_ID --backend traex --inherit-model --inherit-effort
unfold backend REVIEW_ID inherit
unfold analyze REVIEW_ID --model MODEL_FROM_CATALOG --effort high --wait
```

Global defaults are per backend. MR overrides are per backend as well, so switching back restores that backend's overrides. Inheritance resolves at the start of each operation; an in-flight operation keeps its frozen profile. `--model` and `--effort` on `analyze`/`ask` affect only that run. `agent defaults BACKEND --reset` selects the backend's advertised default model and default effort. Unsupported values return a structured error; Unfold never silently downgrades them. Private question sessions are reused only for the same backend, model, effort and source version.

The Web review page exposes the same persistent MR settings as inline Agent/model/thinking effort dropdowns beside the generation button. Selections save automatically through the MR PATCH API, apply to later analysis and questions, and survive reloads; inheritance restores the global/backend defaults. A failed save blocks generation and offers explicit retry or readback. Starting generation makes one request using those saved settings, with no additional dialog. CLI `analyze` and `ask` also accept per-run `--backend`, `--model`, `--effort`, and `--model-default-effort`; the last two are mutually exclusive. At API level, `effort: null` explicitly selects the model's advertised default for that run, while an omitted effort inherits existing MR/global settings. The resulting run and explanation retain the actual backend/model/effort used.

For persistent MR settings, `unfold agent set REVIEW_ID --backend BACKEND --model-default-effort` explicitly uses the selected model’s own default even when global effort is configured. Use `--inherit-effort` to restore global inheritance, or `--effort VALUE` for an explicit supported effort; these choices are mutually exclusive with `--model-default-effort`. The PATCH API represents the persistent default with `agentOverrides[BACKEND].modelDefaultEffort: true`. An `effort` update (including `null` for inheritance) clears that mode unless the same request explicitly enables it. The compact Web controls choose this mode automatically when switching to a model that cannot use the previous effort. Models with no advertised effort support receive no effort field in their isolated config or native turn request.

`import` accepts Codebase MR subpages and nested suffix paths, including checks/job views. It discards view query parameters and fragments, validates the source host and MR number, and stores the canonical MR URL. All subpage forms of one MR reuse its persistent review ID. GitHub PR subpages use the same normalization and deduplication. Web and skill imports use these same providers. GitHub authentication stays with `gh` on the native connector host; `doctor` reports its current availability/account without exposing credentials. See [GitHub setup and limits](github.md).

### Host connector lifecycle

`unfold connector` is the native connector process. Keep one instance per configured Unix socket. For a persistent Linux deployment, adapt `deploy/unfold-connector.service.example`, then use `systemctl --user enable --now unfold-connector`. Restart it after rebuilding the connector software or changing its process environment. Editable CLI installation, authentication, provider, model and effort settings apply automatically without restarting the connector process. Compose runs only the Web/API; the connector remains on the host.

For a host that requires a network proxy or a custom CA, set only those required variables in a private `.local/connector.env` file (mode 0600). The example service loads it explicitly: a user service does not automatically inherit an interactive terminal’s network settings. Keep native authentication in the original credential files.

Run feedback and token usage are persisted with the run. `run RUN --json` and `runs REVIEW --json` return the latest timestamped progress, recent activity, turn identity, and per-run usage. `watch RUN` / `--wait` print public progress and usage updates to stderr; JSON stdout retains the final run contract. Usage is native-reported input/output across all model requests in this run: cached input is already included in input, reasoning is already included in output. Resumed sessions subtract a verified pre-turn baseline. Missing usage stays absent, and failed/cancelled runs retain the last observed partial usage. Viewer APIs never expose private run feedback.

Explanation HTML is stored once under the private artifact directory. SQLite stores its relative file path plus summary, source references, revision and generation metadata; existing read/export/share commands resolve that file through the same service authorization. A missing HTML file produces an explicit error instead of a successful empty explanation. Back up the complete data directory, including SQLite and artifacts.

Logical change guides use `guide REVIEW [--explanation ID] [--point g1-c1]`. The owner and viewer read endpoint is `GET /api/v1/reviews/:id/guide` with `explanationId` / `point` query parameters. It returns revision-bound groups, change points and verified source references. New analyses generate guides alongside full HTML; legacy explanations return `guide_unavailable` until explicitly regenerated. No regeneration occurs on reads.

## Review summary for chat

```sh
unfold review-summary REVIEW
unfold review-summary REVIEW --explanation EXPLANATION_ID > review-summary.txt
unfold --json review-summary REVIEW --explanation EXPLANATION_ID
```

Web **复制 Review 摘要** and CLI share `GET /api/v1/reviews/:id/review-summary?explanationId=ID`. The Web action pins the explanation currently displayed and summarizes the whole review even when a reading path is selected. Native clipboard copying has a selected-text fallback for the company HTTP viewer. No chat message, platform comment, model invocation or ownership refresh occurs.

Example, using synthetic data:

```text
将取消检查提前，避免已取消任务占用 worker。

@runtime · src/：把取消检查前移
@contracts · shared/：统一回调约定

完整讲解（a1b2c3d4）：https://review.company.example/r/REVIEW/v/EXPLANATION
```

The overview uses saved explanation text; each path uses directly relevant change-point titles, preserving cross-path changes. The pasted text starts directly with the overview, without a repository/MR prefix, and ends with 完整讲解 plus its revision-bound URL. The overview remains capped at 110 characters, while every path row includes all its directly relevant point titles, without a per-path point-count or character cap. All path rows are included. Owner labels remain capped at four per row, with an explicit total for larger owner lists. The compatibility fields `omittedPaths` and `sections[].otherPoints` are always zero. `--json` retains all sections, owners and point IDs, plus `text`, `url`, `sourceUrl`, `head`, `versionId`, `explanationId`, `stale`, `omittedPaths` and `mentions: "plain-text"`. Missing/partial ownership stays explicit; missing legacy guides produce an overview/link with a note rather than invented path summaries. Known stale explanations carry a warning and retain their original reviewed commit.

Ownership comes only from the explanation's saved capture. `@name` is a readable label, not a Feishu user-ID mention or evidence that a review invitation was sent. Resolve actual identities in the authorized downstream chat workflow. Sharing requires the configured company-network entry and never falls back to owner/Tailscale/localhost URLs. Visitors can read only published explanation data, just as with the guide/export endpoints.

## Modules and reading scopes

```sh
unfold --json owners REVIEW
unfold --json owners REVIEW --refresh
unfold --json owners REVIEW --explanation EXPLANATION_ID
unfold --json guide REVIEW
unfold --json guide REVIEW --path src/ --point g1-c1
unfold --json share REVIEW --path src/
unfold --json share REVIEW --path src/ --explanation EXPLANATION_ID
```

The Web reader opens **阅读导览** by default, with **完整讲解** for the full HTML. Flat reading-range buttons show **全部改动** and suggested paths, rather than people. `guide` returns the same suggested `paths` array, each with canonical `path`, display `label` and changed `fileCount`; these suggestions use the saved rules or changed directories and are independent of the selected scope. GitHub globs become matching literal prefixes or changed directories, never raw glob labels. Use `--path` to select a path through the CLI. The Web reader only offers suggested paths, with no custom-path editor. Existing incoming path links remain readable.

Paths match an exact file or a directory prefix, including a rename's old/new paths; traversal is rejected. Cross-path change points keep their complete explanation and file list, with `focusFiles` identifying the selected part. Output retains the global `summary`, directly relevant `groups`, module `responsibility` / `reviewFocus`, separately labeled `contextGroups` with reasons and verified references, and ownership capture status. Empty matches return an empty direct list. Legacy `guide` / `share --owner NAME` and owner-based URLs remain supported; the Web reader labels their saved selection without listing names. Choose one legacy owner or one path; unknown owners and conflicting scopes return structured errors.

`owners` reads the current version's cached rules on the management listener. `--version ID` selects another version; `--refresh` explicitly recaptures rules and never changes an existing explanation. New analyses refresh rules once and freeze them into the explanation. `--explanation ID` and all visitor reads return only that explanation's saved capture; historical missing rules are not inferred. Existing guides without module links still support path filtering and report `modular: false`.

Shared guide queries accept `owner` or `path` alongside `explanationId` / `point`. `GET /api/v1/reviews/:id/owners` supports `versionId` for management reads or `explanationId` for saved captures. Owner-only `POST /api/v1/reviews/:id/owners/refresh` accepts an optional `versionId`. Visitors cannot refresh or contact the native provider. Scoped `share` URLs include `/v/EXPLANATION_ID` so a newer analysis cannot change their owner/path meaning. These filters do not restrict a reader's existing access to the full published explanation and its evidence.

Codebase resolves effective owner candidates against pinned ancestor OWNERS files and their `no_parent` setting. The initial parser accepts `reviewers`, `approvals_required` and `no_parent`; other conditions, incomplete source or changed heads produce explicit partial/unknown results. GitHub follows CODEOWNERS location precedence and last-match rules at the captured target tip; empty ownership clears a previous match. These are declared owners, not verified team membership, invitations or current permission grants. For older GitHub snapshots missing the target tip, capture can recover it only if the live PR still matches the exact saved head and merge base. The immutable source version remains unchanged.

`analyze` and `ask` always include the bundled chineseplz `write-plain-chinese` rules, on either backend and in resumed private conversations. Web operations use the same policy. The skill shapes prose within the current generation; it preserves JSON, source references, technical names, facts and uncertainty. `run RUN`, `runs REVIEW`, `show REVIEW` and `history REVIEW` expose the persisted `writingStyle` name, upstream revision, source and effective instruction SHA-256. Historical artifacts without that metadata remain unchanged. The bundled files are fixed at build time; generation does not download skills or inherit personal plugins.

The bundled post-submission skill also provides a CLI workflow helper: `node /path/to/unfold-review/scripts/prepare.mts MR_URL --head FULL_SUBMITTED_COMMIT`. It composes existing CLI/API commands to refresh, verify the submitted revision, reuse/analyze, observe, and verify a pinned visitor URL. It accepts `--cli`, `--server`, `--token-file`, `--client-config`, `--backend`, `--model`, `--effort`, `--regenerate` and `--resume`; success returns structured forwarding data without sending a message. The same script's `configure --server OWNER_API_URL --token-file PRIVATE_KEY_FILE --cli UNFOLD_EXECUTABLE` and `check` commands save/verify a protected per-user binding, independent of the current repository and plugin cache. Token contents remain in the original file. Explicit options override `UNFOLD_SERVER`/`UNFOLD_TOKEN_FILE`/`UNFOLD_CLI`, then the private binding, then an existing Unfold home. `--client-config` or `UNFOLD_CLIENT_CONFIG` selects another private binding. Direct native CLI calls still use their explicit connection flags or existing `UNFOLD_HOME`. See [Agent integration](agent-integration.md) for installation, configuration and recoverable states.

## Incremental analysis artifacts

`unfold --json artifact RUN_ID` lists saved overview/guide/HTML parts and their source version, indices, sizes and content hashes. Add `--content` to read private part content, for example `unfold --json artifact RUN_ID --content > partial-output.json`. This owner-only read also works for failed/interrupted analyses and returns an empty part list for older runs without checkpoints. It does not publish partial HTML, execute it, resume analysis or replay approvals. Private questions do not create explanation artifacts.

`run` and `watch` expose durable `progress.savedParts` / `progress.savedChars` alongside cumulative native usage. Native output-limit failures carry `errorCode: agent_output_limit`; existing failures retain their original records. Final source-reference, guide-coverage and artifact validation still precedes publication.

`activity` reads the owner-only global agent slot, returning `{active: null}` when idle or minimal run/review metadata when occupied. The owner UI shows the active review and a progress link across pages, disables new analysis/questions until release, and keeps unrelated model settings editable. A race-time `agent_busy` conflict includes `details.activeRun`; use that run ID with `watch` or inspect its review. There is no automatic queue or replay.
