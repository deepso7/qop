# Micro-agent charters (pr-review)

## Bugbot

Cross-cutting Cursor `bugbot` subagent — not a pasted charter for `generalPurpose`. Orchestrator launches it per `SKILL.md` (exact prompt shape, `subagent_type: "bugbot"`).

**Owns:** high-recall defect finding across the whole diff — especially composition/API drift, navigation/deep-link bugs, list/render crashes, sticky edge cases, and “consumers still read the old shape” bugs that partitioned charters miss.

**Does not own:** replacing Security/State/Flow (still run those); output formatting (orchestrator merge owns `.mdc` output); fixing code.

### Custom instructions (paste into Bugbot `Custom Instructions:`)

```text
QOP Expo/React Native monorepo PR review. Prefer real bugs with a failure story over style.
Severity: P0 hang/uncaught/wrong results/broken tests; P1 real-user correctness/security (RN render crashes, broken navigation/deep links, data loss, auth/token misuse, permission or P2P trust mistakes); P2 contract/lifecycle/resource or clear lint/CI hole; P3 maintainability with a real failure mode.
Cite path:line from the post-change file. Skip pure taste/nits. Focus extra attention on: Expo Router params/deep links, list virtualization (FlashList) key/recycle bugs, Reanimated/gesture lifecycle after unmount, `{value && <View/>}` / strings outside Text crashes, Uniwind className regressions that hide interactive controls, and @minip2p trust boundaries.
```

### Bugbot → merge normalization

Bugbot’s native output may be prose or a severity table, not our JSON array. Orchestrator maps each actionable item to:

`{"severity":"P0|P1|P2|P3","path":"…","line":N,"finding":"…","confidence":0.85,"reasoning":"from Bugbot"}`

- Map High→P1 (or P0 if hang/wrong-results/broken-test), Medium→P2, Low→P3 unless the failure story clearly warrants higher
- If Bugbot omits a line, open the file and recover a line before publishing; drop the item if you cannot
- Still apply the confirm-before-publish bar on every surviving P0/P1

---

Shared constraints for every **charter** specialist (State/Parse/Security/Flow/Verify/Quality):

- Worktree + `git diff <base>...HEAD` only (plus necessary surrounding / out-of-diff callers), including files the orchestrator lists as untracked/added
- **Read-only**: read files, `rg`/search, `git show`/`git diff`. No `pnpm check` / lint / tsc — the orchestrator owns check runs. Verify alone may run one focused `pnpm check` or `pnpm --filter mobile lint`
- No GitHub review threads
- No style nits; failure story required
- Return a JSON array of findings (may be empty): `{"reasoning","severity","confidence","path","line","finding"}`
- `reasoning` is your scratchpad and is never shown to the user — put the user-facing story in `finding`
- `line` must be read off the post-change file with a file-read tool, **not** counted from diff hunk headers; a wrong line makes the finding unactionable
- Severity bar (inlined from `.cursor/rules/pr-review.mdc` so specialists who only receive this charter need not open the rule file):
  - **P0** hangs, uncaught exceptions that take down the JS process / redbox loops, definitively wrong results, or tests/fixtures that cannot work as written
  - **P1** correctness or security bug likely to hit real users (RN render crashes, broken navigation/deep links, data loss, auth/token misuse, permission or P2P trust mistakes)
  - **P2** contract/lifecycle/resource bugs; clear holes where lint/typecheck/CI won't catch failure
  - **P3** concrete maintainability or portability with a real failure mode (skip pure taste)
- Omit anything with confidence &lt; 0.8
- Finish your charter; do not stop after the first finding
- Read every in-diff hunk relevant to your charter before following out-of-diff callers. Charters partition **failure modes, not files** — expect to share files with other specialists; the merge dedupes

## State

Focus: screen/hook/store invariants, navigation and sheet lifecycle, gesture/animation state machines.

Hunt: duplicate mount/focus handlers; listeners after unmount; sheet/modal dismiss leaving stale “open” state; wrong terminal UI state; ownership handoff (who may write shared store / shared value / ref); retry that cannot make progress; “success” UI before data is usable; Reanimated shared values treated as derived visuals instead of ground truth when that causes stuck press/gesture state; Expo Router focus/blur vs React mount mismatches.

Out-of-diff: callers of changed state-transition hooks / stores / navigation helpers.

## Parse

Focus: route params, deep links, JSON/storage/network bytes in → structured values out.

Hunt: missing/coerced Expo Router search params; deep-link decode gaps; JSON parse without schema; number precision loss; fixture/snapshot field mismatches (even if tests skip the field); accept paths that skip validation; rewrites that rebuild maps/lists and drop fields the old path preserved; URL/encoding mismatches between platforms.

Out-of-diff: other parsers/encoders of the same format in-repo (route helpers, storage wrappers, API clients).

## Security

Focus: secrets in the client bundle, auth/token storage, deep-link injection, WebView/DOM, P2P/peer trust, and untrusted config.

Hunt: secrets committed or logged; tokens in world-readable storage; auth checks after side effects; open relays of attacker-controlled deep links / peer messages; expensive work before size/schema reject; WebView/`expo-dom` loading untrusted HTML without hardening; `@minip2p` trust assumptions violated (accepting peer data as trusted UI/commands); permission prompts used incorrectly so sensitive APIs run without consent.

Out-of-diff: who can invoke the new route / handler / peer message path / storage write.

## Flow

Focus: liveness, JS-thread resources, and render/scroll control flow.

Hunt: `while`/timer/event loops that don’t advance; scroll position tracked in `useState` (render thrashing); unbounded lists mapped in ScrollView instead of FlashList/virtualizer; superlinear buffer ops; subscription/listener/keyboard leaks on unmount; gesture/worklet handlers that keep firing after cleanup; setState loops from layout/effect; `{value && <Component/>}` with empty string/`0` or strings outside `<Text>` (production crash).

Out-of-diff: parents that drive the changed list/scroll/gesture/animation.

## Verify

Focus: proof and claims — _absence_ of coverage, or claims that contradict code.

Hunt: missing tests/checks for new failure modes; CI/`pnpm check`/`expo lint`/typecheck/`package.json` script coverage dropped on rename/split; README/docs claims contradicting code; AGENTS.md violations on touched code (Expo APIs without consulting SDK 57 docs); native deps added only outside `mobile/` (autolinking break); edits under `node_modules`.

Out-of-diff: **before claiming coverage is missing, go look for it.** `rg` the changed symbol and the behavior across sibling `*.test.ts(x)` / `*.spec.ts(x)` / `test/**` modules and package scripts. An absence claim that skipped this search is the single most common Verify false positive — omit it rather than guess.

You are the only specialist permitted to run checks: at most one focused `pnpm check` or `pnpm --filter mobile lint`. Note “green but never loads corrupt field” as evidence when that is a _claims_ bug. Prefer **Quality** when the test exists but is hollow or checklist-duplicative.

## Quality

Focus: hollow proof and LLM-shaped padding in **tests/docs**, plus **internal** no-policy wrappers. Not “thin public API is bad.”

Out-of-diff: peer tests in the same file and sibling test modules covering the same claim (is the new one strictly weaker, or does it add a case?); every call site of a suspected wrapper (`rg` the name — used once with no policy, or genuinely shared?). Both claims are unverifiable from the diff alone.

**Severity mapping**

- **P2**: hollow coverage that can hide real bugs — green tests that never exercise the claimed failure; e2e-in-unit tests that don’t uniquely pin the new API vs an existing one; asserts that skip fields the test name/doc claims to cover; internal wrappers that obscure error/ownership paths (errors remapped or dropped at the forward boundary)
- **P3**: concrete maintainability drag — near-duplicate tests of the same path under two names with no new risk; tautological asserts; plan-echo docs that add no contract; trivial construct/getter-only tests; private helpers or one-field `*Helper`/`*Manager`/`*Util` types that only forward with no policy, validation, or feature gate

**Hunt**

- Tautological asserts (`expect(x).toBe(x)`; post-conditions that only restate a match the wait already required)
- Checklist duplicates: same script under twin names with no distinct risk
- Timing-sensitive unit-test e2e that don’t uniquely prove the new surface
- Variant-only / `toBeDefined` / `length === 1` asserts when peers in-file already match full shapes for the same claim
- Construct-and-roundtrip getters with no property unless the type’s packing/invariants are the point
- Comments/README that restate a plan or the code with no additional contract
- **Internal useless wrappers**: private functions or types whose body is only a call to another symbol in the same package (or a field access + forward), adding no check, default, logging policy, or type conversion — especially new helpers introduced alongside the change “for clarity”

**Do not hunt**

- Formatting, naming taste, “could use a switch”
- “Sounds like an LLM” without a concrete artifact
- **Intentional public / layer facades** that _are_ the API or architectural boundary: design-system re-exports under `mobile/src/components/ui`; Expo Router screen wrappers; Uniwind `withUniwind` bindings; `@expo/ui` Host bridges; platform `.web.tsx` / `.tsx` splits that exist for platform APIs

**Allowlist (intentional — do not flag by default)**

Test-shaped (merge may re-raise if the new test is strictly weaker than in-file peers on the same claim):

- White-box store / navigation injection to pin lifecycle / ownership semantics
- Real timeout-driven tests when they assert a specific outcome (not a slack timing bound alone)
- Fixture twins when each twin is required by a stated merge gate _and_ asserts a distinct type/error path (not a copy with only the name changed)

Facade-shaped (unconditional — not subject to the “weaker peers” clause):

- One-line public methods that exist so callers don’t reach through layers
- Intentional layer facades listed under **Do not hunt**
