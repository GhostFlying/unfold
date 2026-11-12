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
| Read source and revisions                | `diff REVIEW [--path PATH]`, `source REVIEW PATH --version ID [--side old\|new]`, `versions REVIEW`, `history REVIEW`                          |
| Select source context                    | `reference REVIEW PATH --version ID --start N [--end N] [--side old\|new]`                                                                     |
| Export / open / share                    | `export REVIEW --output FILE [--explanation ID]`, `open REVIEW`, `share REVIEW [--explanation ID]`                                             |
| Read / create / edit drafts              | `draft list REVIEW`, `draft show ID`, `draft create REVIEW --body TEXT [--reference ID]`, `draft edit ID --revision N --body TEXT [--general]` |
| Preview / publish / reconcile            | `draft preview ID`, `draft publish ID --confirm DIGEST`, `draft reconcile ID`                                                                  |
| Inspect / decide exact execution request | `approval list`, `approval approve ID --confirm DIGEST`, `approval deny ID --confirm DIGEST`                                                   |

`ask`, `draft create` and `draft edit` accept `--body-file FILE` or `--body-file -` instead of `--body`. No mutation occurs automatically after a preview. There is no blanket `--yes` for publishing or execution. A body/position/version change invalidates the confirmation digest.

JSON success: `{"ok":true,"data":...}`. Errors go to stderr as `{"ok":false,"error":{"code":"...","message":"...","details":...}}`. IDs are durable service IDs, not native backend session IDs. Provider thread IDs in owner run metadata are private and are excluded from shared explanation records.

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

The Web “生成讲解” / “重新讲解” dialog uses these same per-run parameters, without updating global or MR defaults. Changing the model resets the effort control to that model's default and exposes only its advertised efforts. CLI `analyze` and `ask` also accept `--model-default-effort`; it is mutually exclusive with `--effort`. At API level, `effort: null` explicitly selects the model's advertised default, while an omitted effort inherits existing MR/global settings. The resulting run and explanation retain the actual backend/model/effort used.

`import` accepts Codebase MR subpages and nested suffix paths, including checks/job views. It discards view query parameters and fragments, validates the source host and MR number, and stores the canonical MR URL. All subpage forms of one MR reuse its persistent review ID. This is shared by Web and skill imports; URL recognition does not enable the phase-two GitHub provider.

### Host connector lifecycle

`unfold connector` is the native connector process. Keep one instance per configured Unix socket. For a persistent Linux deployment, adapt `deploy/unfold-connector.service.example`, then use `systemctl --user enable --now unfold-connector`. Restart it after rebuilding the connector software or changing its process environment. Editable CLI installation, authentication, provider, model and effort settings apply automatically without restarting the connector process. Compose runs only the Web/API; the connector remains on the host.

For a host that requires a network proxy or a custom CA, set only those required variables in a private `.local/connector.env` file (mode 0600). The example service loads it explicitly: a user service does not automatically inherit an interactive terminal’s network settings. Keep native authentication in the original credential files.

Run feedback and token usage are persisted with the run. `run RUN --json` and `runs REVIEW --json` return the latest timestamped progress, recent activity, turn identity, and per-run usage. `watch RUN` / `--wait` print public progress and usage updates to stderr; JSON stdout retains the final run contract. Usage is native-reported input/output across all model requests in this run: cached input is already included in input, reasoning is already included in output. Resumed sessions subtract a verified pre-turn baseline. Missing usage stays absent, and failed/cancelled runs retain the last observed partial usage. Viewer APIs never expose private run feedback.

Explanation HTML is stored once under the private artifact directory. SQLite stores its relative file path plus summary, source references, revision and generation metadata; existing read/export/share commands resolve that file through the same service authorization. A missing HTML file produces an explicit error instead of a successful empty explanation. Back up the complete data directory, including SQLite and artifacts.

Logical change guides use `guide REVIEW [--explanation ID] [--point g1-c1]`. The owner and viewer read endpoint is `GET /api/v1/reviews/:id/guide` with `explanationId` / `point` query parameters. It returns revision-bound groups, change points and verified source references. New analyses generate guides alongside full HTML; legacy explanations return `guide_unavailable` until explicitly regenerated. No regeneration occurs on reads.

`analyze` and `ask` always include the bundled chineseplz `write-plain-chinese` rules, on either backend and in resumed private conversations. Web operations use the same policy. The skill shapes prose within the current generation; it preserves JSON, source references, technical names, facts and uncertainty. `run RUN`, `runs REVIEW`, `show REVIEW` and `history REVIEW` expose the persisted `writingStyle` name, upstream revision, source and effective instruction SHA-256. Historical artifacts without that metadata remain unchanged. The bundled files are fixed at build time; generation does not download skills or inherit personal plugins.

The bundled post-submission skill also provides a CLI workflow helper: `node /path/to/unfold-review/scripts/prepare.mts MR_URL --head FULL_SUBMITTED_COMMIT`. It composes existing CLI/API commands to refresh, verify the submitted revision, reuse/analyze, observe, and verify a pinned visitor URL. It accepts `--cli`, `--server`, `--token-file`, `--client-config`, `--backend`, `--model`, `--effort`, `--regenerate` and `--resume`; success returns structured forwarding data without sending a message. The same script's `configure --server OWNER_API_URL --token-file PRIVATE_KEY_FILE --cli UNFOLD_EXECUTABLE` and `check` commands save/verify a protected per-user binding, independent of the current repository and plugin cache. Token contents remain in the original file. Explicit options override `UNFOLD_SERVER`/`UNFOLD_TOKEN_FILE`/`UNFOLD_CLI`, then the private binding, then an existing Unfold home. `--client-config` or `UNFOLD_CLIENT_CONFIG` selects another private binding. Direct native CLI calls still use their explicit connection flags or existing `UNFOLD_HOME`. See [Agent integration](agent-integration.md) for installation, configuration and recoverable states.
