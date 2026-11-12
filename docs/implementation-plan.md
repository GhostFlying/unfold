# Unfold implementation plan

## Constraints

- Single owner; every product operation has a CLI and shares the HTTP service with the web UI.
- Codebase first: import a pinned revision, read actual source, explain using an existing TraeX/Codex app-server, ask privately, preview and explicitly publish comments, read replies, share a stable read-only URL.
- GitHub PR support follows the Codebase vertical slice. Public GitHub source hosting is independent of provider implementation order.
- TypeScript / Fastify / React + Vite / SQLite. Compose runs web/API; a narrowly scoped native connector uses existing CLI authentication over a protected Unix socket.
- Both agent backends are selectable globally/per review, default TraeX, with no silent fallback. Dedicated persistent homes must not inherit personal hooks/plugins or permissive execution settings.
- Reviewed code is never executed without approval of the exact command/revision/directory/network request; use credential-free bwrap work copies and retain a receipt. Never modify or push the original repository.
- Company-network share and owner management are separate listeners. Tailscale is owner access only, never a share URL fallback.
- Internal configuration, investigation, real responses, source snapshots, generated artifacts and databases belong under ignored `.local/`, excluded from Docker contexts too. Existing credentials stay in their original stores.

## Implementation

1. Establish configuration, shared contracts, durable SQLite state, connector RPC and CLI. Implement pinned Codebase metadata/diff/discussion/source retrieval.
2. Integrate actual app-server streaming/dynamic tools, strict source access, persisted explanations, private conversation and exact execution approvals.
3. Implement editable revision-bound drafts, preview digests, explicit publishing, readback/reconciliation and unknown outcomes. Real writes require a specifically authorized test target and preview.
4. Build the owner UI and separate read-only viewer with sandboxed, self-contained HTML and a small validated context bridge. Keep prior successful artifacts available across failures and restarts.
5. Verify the Codebase path using real source and an existing agent backend. Then add GitHub and verify the other backend. Ship CLI documentation, Compose, configuration examples and README acknowledgements.

## Acceptance

- Duplicate import has a stable URL; immutable head/base identities; stale explanations and drafts cannot masquerade as current.
- All business operations work through API/CLI and the web UI. Structured outputs, durable operation IDs and event waiting distinguish pending approval, conflict, error and unknown outcome.
- Agent source access is version-bound; arbitrary execution is unavailable by default. Approval cannot authorize another command or survive as a broad permission.
- Guests and generated HTML cannot invoke the agent, read private questions/drafts/receipts or publish comments. Internal material never enters public source/build context.
- Comments pin exact positions, retain independent readable context and reconcile ambiguous transport failures without duplicate retries.
- Restart/recreate retains links, artifacts, history and drafts; interrupted work is not silently replayed.
- Rendered desktop/mobile checks exercise real controls. Real generation, publishing and external visitor access are reported separately from mocks.

## Design and attribution

A restrained white/slate technical reader: slim review rail, a central interactive explanation, collapsible source/diff, and an owner-only question/draft inspector. Native code text and controls remain accessible; no remote CDN.

README must thank and link antfu/pulls.review (logical change grouping), cursor/plugins PR Review Canvas (reviewer-focused walkthroughs), and nicobailon/visual-explainer (self-contained interactive HTML). Retain licenses for any copied code; initially borrow ideas rather than source.

## Model and thinking effort configuration

Expose model catalogs and supported reasoning efforts through the connector, owner API, CLI and UI. Each backend has global model/effort defaults. Each review may override backend, model and effort; removing overrides restores inheritance. Resolve and freeze these settings before each operation, validate them against the actual backend's model list, and record requested/effective settings on the run and explanation. Explicit model changes start a new private session while retaining prior questions as context. Never silently downgrade an unsupported effort or reuse a session with a different model profile.

## Apply saved connector configuration automatically

- Compare effective values so unchanged form fields never trigger a lifecycle warning.
- All editable connection settings can be reloaded online because native app-server processes are per operation. Replace the manual restart requirement with authenticated connector reload/status RPCs; the web container does not receive host service-control privileges.
- Apply an immutable connection-settings revision only while the connector is idle. Active investigations, execution approvals and platform writeback finish with their original runtime. Pending saved settings apply automatically when work drains; expose applied/pending/failed status through the owner API, CLI and settings dialog.
- Validate changed native connections and expose readiness failures as saved-but-not-applied outcomes. New work must not silently use an older connection after a failed reload. Update managed authentication symlinks only at the idle boundary and preserve backend homes/history.
- Add focused coverage for unchanged saves, real changes, deferred application, readiness failure, protected status endpoints and browser feedback. Deploy and verify the settings flow on the existing single-owner installation without replaying comments or approved execution.
- Retain immutable connection identities while applying settings online.

## Investigation feedback and per-run token usage

- Forward public agent progress messages, version-bound tool start/completion, and answer-generation activity through the existing owner-only event stream. Never expose internal reasoning or partial generated HTML as progress prose.
- Persist timestamped progress, a short activity history, and backend-reported token usage on each run. Web and CLI show the same data, elapsed time, and last observed activity without inventing percentages or treating silence as a proven stall.
- Use native cumulative usage snapshots with a verified pre-turn baseline for resumed sessions. Repeated snapshots replace totals; cached input is included in input, and reasoning is included in output. Missing data stays unavailable; cancelled/failed runs retain observed partial usage.
- Add a compact expandable run panel to the existing reader, including completed runs and question runs. Recover event streams after disconnects and preserve progress across page reloads; never rerun analysis to recover its display.
- Verify both locally exported app-server protocols, aggregation across fresh/resumed turns, replay/disconnect behavior, visitor isolation, desktop/mobile rendering, and a real native question. Deploy only after active work drains.
- Apply feedback and usage collection to new runs only; existing explanations remain unchanged and historical runs without usage continue to say unavailable.
- Store full explanation HTML only in its local artifact file; SQLite retains metadata and a relative artifact path. Migrate legacy embedded HTML only after atomic file save, hydrate existing API/CLI responses on reads, and retain the existing authenticated/public read boundaries and fixed URLs.

## Logical change guide

- Provide a dedicated guide organized by behavior/purpose rather than a flat file list. An overview lists logical groups and their individual change points; selecting a point opens its before/after behavior, rationale, risks and validated source references.
- New native analyses produce a small structured guide alongside the self-contained whole-change HTML. Validate group/point bounds and reference IDs against actual pinned source reads; untrusted output never becomes executable host UI.
- Persist the structured guide with explanation metadata, expose it in read-only shared APIs and an explicit CLI command, and keep full HTML in its artifact file. Historical explanations without a guide remain readable with an honest empty state; do not invent categories from file names or silently reanalyze them.
- Match the existing restrained reader, provide keyboard/mobile navigation and source jumps, and acknowledge pulls.review for the grouping interaction without copying its platform or source.

## Plain-language generation with chineseplz

- Vendor the MIT-licensed `write-plain-chinese` skill from M0gician/chineseplz at pinned commit `8993f98573f0cd0a8d2053741006bc38d4972b75`, retaining its original runtime documents, license, file hashes and attribution. Do not install into the owner's personal skills or enable inherited plugins/hooks/tools.
- Include its fourteen writing rules and two terminology/example references in every native analysis/question turn on both backends, including resumed conversations. Apply them to human-readable prose while preserving facts, uncertainty, code, identifiers, references, JSON contracts and sandbox boundaries. Return the requested analysis or answer, with editing reports only when the task requests them.
- Generate and polish within the same analysis turn. CLI analyze/ask and Web use the same policy; record its identity and effective text hash with the run and explanation so the existing CLI read commands can inspect it.
- Bundle the text with compiled connector assets; generation must not fetch external instructions at runtime. Verify fresh/resumed native requests, production asset packaging and a real rewrite on both backends. Deploy after active work finishes, without regenerating existing explanations.

## Post-submission agent skill and Codex plugin

- Package one reusable `unfold-review` skill in a skills-only `plugins/unfold` plugin. Provide portable and Codex compatibility manifests, a repo marketplace, standalone skill installation and documented Codex CLI installation. Keep configuration, owner credentials, company endpoints and chat identities outside the package.
- Give the skill a dependency-free Node helper that composes existing authenticated Unfold CLI operations: import, refresh, check the exact submitted head, reuse a current explanation or analyze, observe existing work via SSE, and return a pinned read-only URL plus a short forwarding message. Check the immutable version again after generation and verify public access without owner credentials. Support backend/model/effort options and explicit run resumption; never return an older explanation as success after failure, approval or source drift.
- Automatically select the skill for an authorized post-PR/MR handoff. Let the calling agent obtain the actual submitted URL/head and perform company-specific chat delivery using its existing tools and authorization. The package does not send messages, pick a group, publish MR comments, or add lifecycle hooks. Include an AGENTS.md example for projects that want every successful submission to prepare a walkthrough.
- Keep phase-one Codebase support explicit; GitHub provider requests retain their existing unsupported result until phase two. Do not infer provider support from this public GitHub source repository.
- Validate workflow reuse, source races, pending approvals, failed runs, duplicate invocations, CLI option forwarding and readonly access with synthetic inputs. Validate manifests/skill metadata and distributable contents; run the helper against a real existing explanation without generating another run or contacting a group. Publish source and reproducible packaging instructions.

## Private client binding across repositories

- Persist the calling agent's CLI path, owner API address and existing token-file reference in a private per-user client file outside plugin caches and source repositories. Resolve explicit options, environment and the saved binding consistently across the standalone skill and plugin; retain explicit legacy Unfold-home access. Missing or invalid bindings return an actionable configuration error instead of guessing a local deployment.
- Add helper `configure` and `check` commands. Validate existing owner authentication before atomic save, store absolute filesystem references with restrictive permissions, and keep token bytes in the original protected file. Configuration is local to the calling machine and never becomes a share URL or plugin manifest value.
- Verify option precedence, use from different working directories, failed-save preservation, missing configuration and standalone packaging. Configure and check the existing installation on this host using its already-authorized private connection details, then validate the real reuse workflow without starting analysis or sending messages. Ship a patch plugin version with updated setup instructions.

## MR URL normalization and per-generation agent selection

- Normalize Codebase MR links at the source adapter boundary: match the canonical repository/MR prefix, accept additional subpage paths, query strings and fragments, and keep host validation, positive safe integer IDs and repository path checks. Store and deduplicate the canonical MR URL so UI, CLI and skill imports share the behavior.
- Add a generation dialog for both initial and repeat analysis. Use the existing real model/effort catalog APIs and modal form styles, initialize from the review's effective configuration, and send explicit backend/model/effort only for the requested generation. Keep persistent global/MR settings separate and retain old explanations during new work or failures. Selecting a model's default effort explicitly clears inherited effort for that run; expose the same choice in CLI.
- Verify URL variants and repeated imports, exact run-profile forwarding and unchanged persistent defaults. Exercise dialog selection, backend/model changes, error/retry feedback and mobile layout in Playwright. Browser plugin not available; use the existing Playwright setup and synthetic source for UI checks. Deploy after active work drains and verify the real example link without posting comments or running project code.
