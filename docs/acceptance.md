# Phase one acceptance

The public record is deliberately sanitized. Exact targets, commits, native receipts, generated source material, network addresses and screenshots of real reviews are retained only in ignored `.local/`.

## Verified with real services

| Capability                                          | Result                  | Evidence boundary                                                                                                                                                                                                                   |
| --------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codebase import, pinned diff, discussion and source | Passed                  | Authenticated bytedcli reads; duplicate import preserves the review ID. Latest platform version is read explicitly.                                                                                                                 |
| TraeX analysis                                      | Passed                  | Actual app-server generation; an interactive explanation with 30 validated source references. A scenario control changed the rendered explanation in Chromium.                                                                      |
| Codex analysis                                      | Passed                  | Actual app-server generation using an explicit model and medium effort; 27 validated source references.                                                                                                                             |
| Private continuous questions                        | Passed on both backends | Same backend/model/effort resumes a private native thread. Backend/effort changes establish another thread. Questions remain outside shared explanations and platform comments.                                                     |
| Global and MR model/effort settings                 | Passed                  | Native model catalogs advertise available efforts; CLI/API/UI share persisted settings. Actual runs record medium and low effort separately. Unsupported efforts are rejected.                                                      |
| Native Codebase comment writeback                   | Passed                  | Two owner-authorized test comments: one general and one inline. Platform readback confirmed both IDs, publication markers, exact old/new commits, path, side and line.                                                              |
| Company-network stable share                        | Passed                  | A second host read the actual viewer page, explanation and source evidence over the company-network entry. Private routes and agent mutations returned 404. Local Chromium also exercised the deployed viewer's actual interaction. |
| Tailscale management                                | Passed                  | A separate owner HTTPS entry, owner sign-in and secure cookie verified; a second host read owner health. Existing Serve routes were preserved. Sharing uses a different company-network address.                                    |
| Compose deployment                                  | Passed                  | Web/API container communicates with the host connector through its protected Unix socket. The container is read-only with dropped capabilities; owner is loopback-bound and viewer is bound independently.                          |

The complex read example and the specifically authorized write target are separate reviews. The write target also received a real analysis and a verified visitor link. No reviewed project build, test or dependency installation was performed during these live checks. Test claims in source descriptions remain external evidence.

## Automated verification

`pnpm check` runs TypeScript checks, 21 focused tests, and a production build. `pnpm test:e2e` runs five Chromium tests for the reader, source selection and editable preview, viewer restrictions, hostile HTML, mobile layout, and MR model/effort settings.

Synthetic tests cover concurrent duplicate import, latest-version changes and old explanations, side-aware diff positions, unknown publication results and marker reconciliation, idempotent/concurrent publishing, explicit general-comment relocation, preview digest changes, restart interruption, private source caches, unshared reviews, API authentication/origin checks, exact single-use execution approvals, and long event-history replay. A real bwrap process with a synthetic snapshot verifies a separate network namespace, an empty credential environment, inaccessible owner files and disposable writes. It is not execution proof for any reviewed repository.

Source snapshots and HTML have private filesystem artifacts alongside their SQLite records. Git ignores and Docker context exclusion protect `.local/` and runtime configuration. Public screenshots contain synthetic data only.

## Delivery boundaries

- Phase two GitHub PR ingestion and comment writeback are not implemented. The public GitHub source repository is independent of that provider.
- Real version races, platform timeouts and partial write outcomes were not induced on a live review. Their handling is covered with synthetic platform responses.
- Project execution requires another exact owner approval. Large snapshots are bounded; binary files, symlinks, submodules and unavailable source are rejected instead of producing a partial executable checkout.
- Connector and service interruptions do not replay an approval, a publication or an analysis. An uncertain publication requires marker reconciliation.
- This is a single-owner deployment with one analysis slot, not a team platform or an author-agent scheduler.
