# Fork maintenance: upstream sync, CI and deployment

How this fork (`Agent-Cognitive-Enterprise/gods-eye-view`) keeps the
early-warning Autopilot while continuing to take every upstream release of
`bilawalsidhu/gods-eye-view`. Feature documentation: [EARLY-WARNING.md](EARLY-WARNING.md);
operator guide: [AUTOPILOT-OPERATOR.md](AUTOPILOT-OPERATOR.md).

## Branch policy

| Branch                                   | Role                                                                                                       | Who writes                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `upstream/main`                          | The original project. Fetch only; the push URL is disabled in local clones.                                | Upstream maintainers                 |
| `origin/main`                            | Clean mirror of `upstream/main`, never a fork-only commit. Fast-forwarded by the sync workflow or by hand. | Sync workflow / maintainer (ff only) |
| `feature/global-early-warning-autopilot` | Integration branch: all fork features, upstream merged in through reviewed pull requests.                  | Maintainer, reviewed sync PRs        |
| `release/autopilot`                      | Optional deployable line: fast-forwarded from the integration branch only after Fork Autopilot CI passed.  | Maintainer                           |
| `sync/upstream-<up>-<target>`            | Short-lived merge candidates opened by the sync workflow.                                                  | Sync workflow                        |

Chosen to be the least disruptive to GitHub: `main` stays comparable with
upstream (clean "N commits behind" in the UI, upstream PRs apply as-is), and
the fork's own history lives on its own branches. Nothing is force-pushed;
history is never rewritten.

**GitHub settings this needs (one-time, in the fork's Settings):**

- Actions enabled for the fork.
- Default branch set to `feature/global-early-warning-autopilot` (or
  `release/autopilot` once it exists). GitHub runs _scheduled_ workflows only
  from the default branch, and `main` must not carry fork files. Until this
  is set, run **Upstream sync** manually (Actions tab, _Run workflow_).
- No personal token or secret. The workflow uses only the built-in token,
  whose pushes start no other workflow, so upstream workflow files never run
  in this fork with its secrets. When upstream changes `.github/workflows/`,
  the run opens an issue and that sync is done by hand (manual sync below).

## Where the fork touches upstream code

New files are fork-only (`src/intel/`, `server/providers/intel/`,
`server/providers/fastfeeds/`, `src/ui/fastIntelPanel.js`,
`src/ui/fastIntelPresentation.js`, `src/ui/stores/fastIntel.js`,
`src/ui/views/panels/FastIntelPanel.vue`, `server/providers/localVoice/`, `src/voice/local*.js`, `src/ui/intelConsole.js`,
`src/ui/styles/intel.css`, `src/ui/dockAutoHide.js`, `src/airsea/`,
`src/layers/airsea/`, `server/providers/airsea/`, `src/bankingAccess/`, `src/layers/bankingAccess/`,
`server/providers/bankingAccess/`, the fork docs and workflows). Upstream files the
fork edits are the merge surface; keep these edits additive and small:

| File                                                                                         | Fork change                                                                                                                |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `server/providers/local.js`                                                                  | Registers the intel, air/sea and local-voice plugins; shares the watcher and hub; isolated instances skip AIS and OpenSky. |
| `src/app/tools.js`, `src/standalone/tools.js`                                                | Mounts the Autopilot console and dock auto-hide; offers `local` voice; Air & Sea layer reveal.                             |
| `src/ui/views/LayerPanelsView.vue`                                                           | FEEDS, FAST INTELLIGENCE and LIVE TV panels at the end of the left stack.                                                  |
| `src/ui/panelRailCatalog.js`, `index.html`                                                   | Rail icons for the four fork panels, and those glyphs in the icon font request.                                            |
| `src/ui/leftPanelRail.js`, `src/panelStackLayout.js`                                         | Reads `--left-stack-base-top` and `--panel-rail-band`; a `data-panel-fill` panel takes the height the others leave.        |
| `src/ui/rightPanelRail.js`                                                                   | Lines the right rail up with the left one when the rails sit above their columns (`--panel-rail-band`).                    |
| `src/layers/submarineCables/ingestion.js`, `src/data/localGeojsonCore.js`                    | Pin canvases become data URLs (`stabilizeBillboardImages`), so the atlas holds one pin, not one per reuse.                 |
| `src/layers/launches/overlays.js`                                                            | The hover reticle is a data URL, for the same reason.                                                                      |
| `src/layers/submarineCables/rendering.js`, `surface.js`, `index.js`                          | On the terrain globe cable lines are not clamped (`cableLinesClampToGround`).                                              |
| `src/layers/submarineCables/lifecycle.js`, `state.js`                                        | `syncCableClamp` every frame; `_cableClamp` holds the applied choice.                                                      |
| `src/layers/submarineCables/ingestion.js`                                                    | Waits for the geoid grid so lines are placed at sea level (`placeAtSeaLevel`).                                             |
| `src/data/telegeographySubmarineCables.js`                                                   | Re-exports `cableLinesClampToGround`.                                                                                      |
| `src/ui/panelAccordion.js`, `src/ui/panelChrome.js`                                          | FEEDS and FAST INTELLIGENCE are companions, the one exception to the one-panel rule.                                       |
| `src/ui/stores/panels.js`, `src/ui/PanelRailView.vue`, `src/ui/kit/UiRail.vue`               | The rail can show more than one item open.                                                                                 |
| `server/providers/aircraft/opensky.js`, `adsb-lol.js`                                        | One `publishTrafficSnapshot()` call after each cached snapshot (air/sea).                                                  |
| `src/app/constructCatalog.js`, `src/ui/layerPanel.js`, `src/ui/layerNames.js`                | The five Air & Sea layers and Banking Access, local-only metadata, groups.                                                 |
| `src/sources/reference.js`, `src/app/sourceComposition.js`, `src/voice/layerManifest.js`     | `air-sea` and `banking-access` contracts; the six layers listed voice-off.                                                 |
| `src/creditAttribution.test.mjs`, layer-count tests                                          | Vetted dock-hidden credit selectors; catalog size 46.                                                                      |
| `src/ui/views/ContextView.vue`, `style.css`                                                  | AUTOPILOT panel and stylesheet import.                                                                                     |
| `src/voice/commands.js`, `src/voice/providerCapabilities.js`, `src/ui/views/panels/VoiceControl.vue` | Local voice provider entry and translated label.                                                                   |
| `scripts/package-boundaries.json`                                                            | Owned-module entries for the new modules.                                                                                  |
| `src/i18n/locales/*.json`, `src/i18n/same-as-english.json`                                   | Added strings (append-only).                                                                                               |
| `src/data/dataCredits.js`, `DATA_SOURCES.md`, `.env.example`                                 | One credit entry, source rows and notes, commented settings.                                                               |
| `server/providers/vessels/ais-live.js`                                                       | The AIS lease (`isolation.js`); ingest is wrapped by `tapRegionalAisIngest`.                                               |
| `README.md`                                                                                  | One line at the top linking `docs/AUTOPILOT.md`; on a conflict, keep upstream, re-add it.                                  |

The merge check flags conflicts and both-sides changes in these areas
(`autopilot-hooks`, `voice`, `director`, `camera`, `i18n`, `dependencies`,
`ci`).

## Merge check (local, any time)

```powershell
git fetch upstream
node scripts/upstream-check.mjs                 # report only (git, seconds)
node scripts/upstream-check.mjs --gates quick   # + format, boundaries, Autopilot/voice tests, build
node scripts/upstream-check.mjs --gates full    # + the whole unit suite
```

It merges in a temporary git worktree, so the checkout, its working tree and
any running server are untouched, and removes the worktree afterwards
(`--keep` leaves it for inspection). Exit code 0 clean, 2 conflicts,
3 gate failure. `--json` and `--summary file.md` give machine and Markdown
reports.

## Manual sync

Only with a clean working tree. Keep the printed rollback point.

```powershell
git status --short                      # must be empty
git rev-parse HEAD                      # rollback point
git fetch upstream
node scripts/upstream-check.mjs --gates quick
git switch main
git merge --ff-only upstream/main       # stops if main has diverged: investigate, never force
git push origin main
git switch feature/global-early-warning-autopilot
git merge main                          # resolve conflicts deliberately (see the table above)
npm ci
npm run format:check
npm run check:boundaries
npm test
npm run build
git push origin feature/global-early-warning-autopilot
```

If a conflict appears, note each path and both sides' intent before editing,
prefer upstream's structure and re-apply the fork's small hook, then rerun
every gate. `git merge --abort` returns to the rollback point at any time
before the merge commit.

Each locale upstream ships needs the fork's strings too: after a merge,
`npm run i18n` lists what is missing and the catalog tests fail until it is
translated. `--gates quick` does not run those tests; `--gates full` does. The
fork's strings in `de`, `fr`, `it`, `ja`, `pt` and `uk` were added in the sync
with upstream 423ca3ca and have not had a native speaker's review.

Upstream also prunes strings it no longer uses, and that merges without a
conflict even when the fork still uses them: `NEW` was lost this way in the sync
with a725178e. Restore such a string from the fork's side of the merge, with its
existing translations.

## Automated sync (`.github/workflows/upstream-sync.yml`)

Weekly (Monday 04:23 UTC) and on demand:

1. **propose** (write token, no upstream code executed): fetches upstream,
   fast-forwards `main` if it has not diverged, runs the git-only merge check,
   then either pushes `sync/upstream-<up>-<target>` and opens a pull request into the
   integration branch, or opens/updates an issue listing the conflicting files
   and their areas, or the upstream workflow files that need a manual sync.
2. **verify** (read-only token, no secrets): runs Fork Autopilot CI on the
   candidate. This is the first point where upstream code executes.
3. **report**: comments the CI result on the pull request.

Merging the pull request is a human decision. Nothing is deployed by any
workflow.

## CI (`.github/workflows/fork-autopilot.yml`)

Runs on pushes and pull requests to the integration and release branches,
manually, and from the sync workflow. Read-only token, pinned actions, no
secrets. Additive to upstream's `ci.yml` (which keeps running unchanged).

| Job                               | What it proves                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gates, audit and Autopilot tests  | `npm audit --omit=dev --audit-level=high`, doctor, format, boundaries, the Autopilot/feeds/local AI/voice suites, `npm test`, production build.                          |
| Autopilot browser drill (offline) | Production build served by `vite preview` with `GEV_INTEL_OFFLINE=1`: smoke test and the full Autopilot drill in headless Chrome (A01–A03, A09, A11); evidence uploaded. |
| Windows production smoke          | `windows-latest`: Autopilot/voice suites, production build, `vite preview`, smoke test.                                                                                  |

Offline mode (`GEV_INTEL_OFFLINE=1`) contacts no feed, `GEV_LLM_DISABLED=1`
keeps scoring rule-based, and voice is off, so CI never depends on, or
calls, an outside service.

## Deployment (Windows, explicit)

The local installation is updated only by an operator running
`Deploy-GEV.ps1` from the runtime folder (see the operator guide):

```powershell
.\Deploy-GEV.ps1 -Ref origin/release/autopilot            # CI must be green for that commit
.\Deploy-GEV.ps1 -Ref <commit> -SkipCiCheck               # local-only commit; local gates only
```

It refuses a dirty tree, a detached HEAD or a non-fast-forward; records the
rollback point in `logs\deploy-<instance>-<time>.json`; checks GitHub's
check runs for the exact commit (all three Fork Autopilot CI jobs must have
succeeded); runs `npm ci` if the lockfile changed, the local gates and a
production build; restarts the instance and runs the smoke test. Any failure
after the branch moves resets it to the rollback point and restarts that
version. `Test-GEV.ps1` runs the smoke test on its own.

## Air & Sea: enabling and rolling back

Air & Sea reaches an installation only through the normal deployment above,
after `feature/air-sea-monitor` is merged and verified. It is off unless
`GEV_AIRSEA_ENABLED=1` is set in `.env`.

- **Switch it off, keep the code:** remove `GEV_AIRSEA_ENABLED=1` and restart.
  The routes answer 404, the layers report it, nothing is collected and the
  Autopilot feed is not registered. `GEV_INTEL_AIRSEA=0` keeps the layers but
  takes the signals out of the Autopilot.
- **Go back a version:** run `Deploy-GEV.ps1 -Ref <rollback commit>`; the
  rollback point is in `logs\deploy-<instance>-<time>.json`.
- **Data:** everything lives in `.gev-cache/airsea/` (`traffic.sqlite` and its
  `-wal` and `-shm` files, `warnings.v2.json` and perhaps an older
  `warnings.json`, `zones/`). It is safe to delete
  while the server is stopped, but traffic history cannot be rebuilt: the
  baselines start again and comparisons need two more weeks. Events already
  ingested stay in the Autopilot store until they expire.
- **Warning outlines:** `warnings.v2.json` keeps each zone outline once and
  every warning refers to it. A `warnings.json` beside it is the older form
  (every outline copied into every warning; it reached 535 MB). This code
  never writes it, so code from before the change still finds it after a
  rollback. It is read first only when it is newer than `warnings.v2.json`
  (older code saved it during a rollback; if it is damaged,
  `warnings.v2.json` is read instead), and on its own only while there is
  no `warnings.v2.json` and none was ever set aside as unreadable. Delete it
  once the rollback window has passed. To empty the store, stop the server
  and delete both files: `warnings.v2.json` alone would bring the older
  file back.
- **An unreadable store:** a damaged `warnings.v2.json` is renamed
  `warnings.v2.json.unreadable-<time>`; the server starts without saved
  warnings and the feeds refill them (warnings that ended before the damage
  are not brought back). A file that cannot be opened (held by another
  program, or not permitted), or a damaged one that cannot be moved aside,
  is read again three times over about two seconds. If it still cannot be
  read, it is left as it is and the warning
  feeds are not polled: nothing is gathered that could disagree with it and
  nothing writes over it. Each scheduled poll tries the whole load again;
  once it reads, polling goes on from it as after a start (each feed timed
  from its saved last success). While waiting,
  the log says `warnings not polled or saved` once an hour and
  `/api/airsea/warning-sources` shows the reason in `saving_paused`.
- **Keys:** AISStream allows one connection per key, and each instance with
  `AISSTREAM_API_KEY` opens its own. Air & Sea needs no new key.
