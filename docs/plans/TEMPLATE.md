# Plan template — cross-platform feature plans

Every plan in `docs/plans/` follows this structure. Keep it dense and decision-oriented; a reader
should be able to start implementing, or decide NOT to, without opening anything else first.

---

## Header

```
# Plan NN — <Feature name>
Status: DRAFT | READY | BLOCKED
Depends on: <other plan numbers>
Parity ref: FEATURE-PARITY.md <F-numbers>
```

## 1. What this feature is
2–4 sentences, plain language. What the user sees. Reference the CareUEyes screenshot(s) in
`research/careueyes/images/` where relevant.

## 2. Current state
What exists in the repo TODAY. Exact file paths and function signatures of the seams involved
(`src-tauri/src/...`, `src/features/...`). What is Windows-only, what is already portable.

## 3. Per-platform verdict table
The most important section. One row per platform/environment. Verdict is one of:
**FULL** (works properly) · **PARTIAL** (degraded, say how) · **BLOCKED** (impossible, say why) ·
**UNVERIFIED** (needs a spike before committing).

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | | | |
| macOS (Intel) | | | |
| macOS (Apple Silicon) | | | |
| Linux X11 | | | |
| Linux Wayland — KDE | | | |
| Linux Wayland — GNOME | | | |
| Linux Wayland — wlroots | | | |

Cite `docs/platform-research/{macos,linux}.md` for every non-obvious claim. If the research marked
something UNVERIFIED, carry that tag through — do NOT upgrade it to a confident claim.

## 4. Design
The abstraction: trait/enum shape, where the platform split lives, what the shared code owns.
Include the actual Rust signatures you intend to add. Note any change to the settings schema, the
IPC surface (`commands_registry.rs`), or `src/bindings.ts` (generated — never hand-edited).

**Call out data-model consequences of the weakest platform.** e.g. if one backend can never supply
a field, it must be `Option<...>` from day one, in Rust *and* in the generated TS.

## 5. Implementation steps
Ordered, each independently reviewable and each leaving the repo green. Name the files touched.
Mark steps that need a spike before they can be estimated.

## 6. Permissions, packaging, distribution
Entitlements, TCC prompts, udev rules, polkit, group membership, portal app-ID registration,
sandbox/Flatpak/Snap implications, App Store / notarization consequences. Say plainly if a step
forecloses a distribution channel.

## 7. Failure modes & degradation
What the user sees when it can't work. **Silent no-ops are the enemy** — every plan must say how the
feature reports its own unavailability to the UI. What restores state on crash/exit.

## 8. Testing
Unit-testable pure logic (the geometry/maths/decision tables). What can only be verified manually,
on which hardware. Note anything that cannot be tested in CI.

## 9. Open questions / spikes needed
Explicit list. Anything the research left UNVERIFIED that this plan depends on.

## 10. Effort
Rough size (S/M/L/XL) per platform, and the single biggest risk.
