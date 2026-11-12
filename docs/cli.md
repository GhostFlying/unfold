# CLI contract

Run `pnpm unfold --help`, or build and invoke `node bin/unfold.mjs` / link the executable locally. Global options are `--json`, `--server URL`, and `--token-file FILE`. Source host configuration is explicit; there is no arbitrary URL fetch endpoint.

| Operation                                | Command                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialize local configuration           | `init --codebase-host HOST [--share-base-url URL] [--share-bind ADDRESS]`                                                                      |
| Run HTTP service / native connector      | `serve` / `connector`                                                                                                                          |
| Diagnose CLI availability                | `doctor`                                                                                                                                       |
| Print owner key explicitly               | `auth token`                                                                                                                                   |
| Read / change shared configuration       | `config show`, `config set KEY JSON_VALUE`                                                                                                     |
| Import / list / read / refresh           | `import URL [--backend traex\|codex]`, `list`, `show REVIEW`, `refresh REVIEW`                                                                 |
| Change per-review backend                | `backend REVIEW traex\|codex`                                                                                                                  |
| Generate / ask                           | `analyze REVIEW [--backend NAME] [--wait]`, `ask REVIEW --body TEXT [--reference ID] [--explanation ID] [--wait]`                              |
| Observe / stop                           | `runs REVIEW`, `watch RUN`, `cancel RUN`                                                                                                       |
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
| 6    | Authentication required                                                        |

`analyze` and `ask` without `--wait` return a run ID immediately. With `--wait`, the CLI observes SSE until success, failure, interruption or a pending execution approval. Exit 3 carries the run ID; inspect `approval list`, decide the exact request and call `watch RUN`. Disconnecting the observer does not cancel a run. `cancel RUN` is explicit. An unknown publication remains blocked until a successful readback identifies the original comment; it is not implicitly reset to a fresh draft.

Configuration edits that affect backend executable/model/authentication or connector routing require restarting the connector. Authentication files are never returned to the generated page or written to the source tree. Keep runtime configuration and receipts under `.local/`.

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

### Host connector lifecycle

`unfold connector` is the native connector process. Keep one instance per configured Unix socket. For a persistent Linux deployment, adapt `deploy/unfold-connector.service.example`, then use `systemctl --user enable --now unfold-connector`. Restart it after changing CLI installation/authentication locations or rebuilding the connector. Saved model/effort defaults apply to new operations without restarting it. Compose runs only the Web/API; the connector remains on the host.

For a host that requires a network proxy or a custom CA, set only those required variables in a private `.local/connector.env` file (mode 0600). The example service loads it explicitly: a user service does not automatically inherit an interactive terminal’s network settings. Keep native authentication in the original credential files.
