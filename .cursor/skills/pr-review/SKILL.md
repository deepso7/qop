---
name: pr-review
description: >-
  Orchestrated high-depth PR review for the QOP Expo monorepo: planner + parallel micro-agents (Bugbot/State/Parse/Security/Flow/Verify/Quality), then merge with confidence gating. Use for /pr-review, /pr-review ultra, or orchestrated multi-agent PR review (not the single-agent rule alone).
disable-model-invocation: true
---

# PR review (orchestrated)

## Goal

Beat single-pass review on recall via **planner → specialized micro-agents → merge**. This skill is the orchestration layer only.

## Ownership (do not drift)

| File | Owns |
| --- | --- |
| `.cursor/rules/pr-review.mdc` | Severity bar + **output format** (summary, table, per-finding lines, copy block). Do not invent extra output sections here. |
| `.cursor/skills/pr-review/reference.md` | Specialist charters (hunt / do-not-hunt / allowlists) |
| This `SKILL.md` | Diff source, specialist selection, fan-out, merge, modes |

Quality policy lives in `reference.md`. The `.mdc` stays generic for standalone / Bugbot use — do not duplicate Quality bullets into the rule.

## Diff source

- Default: `git diff origin/main...HEAD` (+ dirty tree if present)
- **Untracked files never appear in any `git diff`** — run `git status --porcelain`, and treat untracked non-ignored files as fully added. Skipping this silently drops whole new modules from the review
- Do **not** read GitHub bot/human review comments unless asked to compare

**Arg grammar** (optional tokens after `/pr-review`):

```text
/pr-review [ultra] [worktree <path>] [base <sha|ref>]
```

- `worktree <path>` — review that checkout instead of the current workspace
- `base <sha|ref>` — diff `base...HEAD` (default `origin/main`)
- Flags and key/value tokens may appear in either order; unknown tokens → ask once, do not guess

## Tools (keep few)

Orchestrator: read files, `rg`/search, `git show`/`git diff`, focused checks. This monorepo uses **pnpm workspaces**:

- Lint/format gate: `pnpm check` (ultracite / oxlint / oxfmt)
- Mobile lint: `pnpm --filter mobile lint`
- Typecheck when available: `pnpm --filter mobile exec tsc --noEmit`

No sprawling toolkits.

Specialists are **read-only** — no `pnpm check` / lint / tsc. Verify alone may run one focused check (`pnpm check` or `pnpm --filter mobile lint`); parallel check runs contend on install/cache and stall.

## Pipeline

### 1. Planner (you)

From the diff only:

1. List changed paths and a one-line blast radius (what can break) — map paths to packages: `mobile/` (Expo app), root config (`package.json`, `pnpm-workspace.yaml`, `oxlint.config.ts`, `oxfmt.config.ts`, `AGENTS.md`)
2. Note symbols/APIs whose **callers outside the diff** must be checked (out-of-diff)
3. Pick which specialists to run (see selection rules below)
4. Emit a short plan; then launch specialists **in parallel** (separate subagents / Task calls)

**Specialist selection**

- Default on nontrivial PRs: **Bugbot**, State, Parse, Security, Flow, Verify — drop a charter specialist only if its charter has zero touch surface; **never drop Bugbot** on nontrivial PRs (it is the cross-cutting recall lane)
- **Quality**: run when the diff touches tests (`**/test/**`, `**/*.test.ts`, `**/*.spec.ts`, `**/*.test.tsx`) **or** adds/changes internal helpers, wrapper types, or doc/README/AGENTS blocks that assert contracts; otherwise skip
- Never drop Verify solely because Quality is running — they own different failure modes
- `/pr-review` counts as an explicit Bugbot request (required by the Bugbot Task type)

### 2. Micro-agents (parallel)

Launch **all selected specialists in one parallel wave**, including Bugbot.

**Charter specialists** (State/Parse/Security/Flow/Verify/Quality) inherit the parent model — omit `model` on Task unless the user names one. Each gets: worktree path, exact `base...HEAD`, changed-file list (including untracked/added files), planner blast-radius notes, and **only its charter** (see `reference.md`).

Charter specialists receive only this skill’s pasted charter — they do not auto-load `pr-review.mdc`. Paste `reference.md`’s shared constraints (severity bar, confidence gate, line-number rule) into every charter specialist prompt, or they will invent their own P0–P3 scale.

Every **charter** finding **must** be structured:

```json
{"reasoning":"…","severity":"P0|P1|P2|P3","confidence":0.0-1.0,"path":"file","line":123,"finding":"what breaks + who is hurt. fix hint."}
```

For Quality, “who is hurt” may be _reviewers/maintainers misled by false confidence_ or _future regressions the test cannot catch_.

**Bugbot** is not a charter `generalPurpose` Task — launch exactly one Task with:

- `subagent_type: "bugbot"`
- `description: "Bugbot"`
- `run_in_background: false`
- Do **not** pre-compute the diff for Bugbot; it computes its own from the repo path
- Prompt shape (exact keys):

```text
Full Repository Path: <worktree or workspace root>
Diff: branch changes
Base Branch: <only when user passed `base <ref>` — use that ref; otherwise omit this line>
Custom Instructions: <paste reference.md Bugbot custom-instructions block>
```

If Bugbot fails because the diff could not be computed, retry **once** with `Diff: natural language`, omit `Base Branch`, and supply a `Change Description` (one block per changed file). Other failures: retry once with the same prompt; then surface the blocker and continue the merge with charter findings only.

Charters:

| Agent | Owns |
| --- | --- |
| **Bugbot** | Cross-cutting defect recall (composition, navigation, list/render crashes, sticky edge cases) — complementary to partitioned charters |
| **State** | Invariants, lifecycle, remount/focus/sheet dismiss, gesture/animation state, post-unmount behavior |
| **Parse** | Route params, deep links, JSON/storage schemas, fixtures, validate-before-side-effects |
| **Security** | Secrets in client, auth/token storage, deep-link injection, WebView/DOM, P2P/peer trust, expensive work before reject |
| **Flow** | Spins, JS-thread starvation, unbounded lists/buffers, subscription/listener leaks, render loops |
| **Verify** | _Missing_ tests/checks for new failure modes; CI/lint/typecheck gaps; README/doc lies; AGENTS.md / Expo policy |
| **Quality** | _Hollow_ proof and LLM-shaped test/docs padding; internal no-policy wrappers — not intentional public/layer facades |

Charter specialists must: stay in charter; read every in-diff hunk relevant to that charter before following out-of-diff callers; not stop after one hit; confidence &lt; 0.8 → omit. Charters partition **failure modes, not files** — two specialists reading the same file is expected, and the merge dedupes. Bugbot may overlap any charter; merge prefers the clearest failure story.

### 3. Merge (you)

1. Collect charter findings with confidence ≥ 0.8. Normalize Bugbot rows into the same shape (see `reference.md` Bugbot → merge); treat Bugbot items that cite `file:line` + a concrete failure story as confidence ≥ 0.8 candidates, then confirm
2. Dedupe near-duplicates (same root cause → keep highest severity / clearest). Prefer Verify for “test/check missing”; prefer Quality for “test present but hollow/duplicate”; prefer Bugbot when it has the sharper composition / crash story and a charter only restates it vaguely; a test that **cannot pass as written** is a P0 defect, not a Quality finding
3. Drop nits / pure style even if a specialist emitted them — including Quality naming taste or “sounds like an LLM” without an artifact. **Quality floor:** a finding that names a specific `file:line` artifact and states what bug or regression it would fail to catch is **not** a nit — keep it
4. Apply the `reference.md` allowlist:
   - **Test-shaped** entries: drop the finding **unless** the new test is strictly weaker than in-file peers covering the same claim
   - **Facade / one-line public API** entries: drop unconditionally — those are intentional layer boundaries, not “weaker peers”
5. **Confirm before publishing.** Specialist confidence is self-reported and uncalibrated — for every surviving P0/P1 (charter **or** Bugbot), open the cited `file:line` yourself and re-derive the failure story from the code, not from the specialist's summary. Drop what you cannot reproduce; fix the line number if it drifted. Do the same for any P2 two specialists describe differently
6. Optional: run focused `pnpm check` and/or `pnpm --filter mobile lint` once; fold hard evidence in
7. Output **exactly** per `.cursor/rules/pr-review.mdc` Output section (summary line, table, per-finding evidence, copy block). Include Quality and Bugbot findings in the table and copy block when they survive. If nothing survives, say `**No issues found** across X files` and emit **no** copy block. Do **not** add undeclared sections (no separate severity-count block, no “Bugbot said…” appendix)
8. Do not fix code unless asked

## Modes

- **normal** (default): Bugbot + defect specialists + Quality when its selection rule matches; thorough but time-bounded
- **ultra**: same agents (including Bugbot), one wave — each **charter** specialist extends **its own** charter with an out-of-diff pass over the planner's symbol list _after_ finishing its in-diff hunks. Bugbot keeps its fixed prompt (it already does deep cross-cutting review). No second launch, no generic caller-sweep agent; use when user says ultra or PR is large/risky

## Examples

```text
/pr-review
/pr-review ultra
/pr-review worktree /path/to/wt base <sha>
/pr-review ultra base origin/main
```
