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
