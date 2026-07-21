# Skill Changelog - Update to FSD v2.1

## Version 2.1.0 - Updated based on Feature-Sliced Design v2.1

### 🎯 Major Changes

#### "Pages First" Approach
- **NEW**: Core principle added - keep code in pages/widgets until you need to reuse it
- Updated all examples and patterns to reflect this approach
- Added detailed explanation of when to extract code to lower layers

#### Updated Layer Descriptions

**Pages Layer**:
- ✅ Can now contain forms, validation logic, API calls, state management
- ✅ No longer just a "thin composition layer"
- ✅ Pages can have their own `model/`, `api/`, `lib/` segments

**Widgets Layer**:
- ✅ Can now contain their own stores, business logic, and API interactions
- ✅ Not just compositional blocks anymore
- ✅ Extract to features/entities only when multiple widgets/pages need the code

**Features Layer**:
- ✅ Emphasis on **reusability** - only create when used in multiple places
- ✅ Don't create features prematurely

**Entities Layer**:
- ✅ Emphasis on **reusability** - only create when used in multiple places
- ✅ New `@x/` directory for cross-import APIs

**Shared Layer**:
- ✅ Can now contain application-aware code (route constants, API endpoints, company logos)
- ✅ Still cannot contain business logic
- ✅ Segments can import from each other

### 🆕 New Features

#### Public API for Cross-Imports (@x notation)
- Added comprehensive documentation for the `@x` notation
- Allows explicit connections between entities
- Examples of when and how to use cross-imports
- Makes bidirectional relationships between entities explicit

```typescript
// entities/user/@x/order.ts
export { UserOrderHistory } from './ui/UserOrderHistory';
```

#### Deprecated Processes Layer
- Added note that Processes layer is deprecated in v2.1
- Migration guidance: move code to Features with help from App layer

### 📚 Updated Documentation

#### Decision Framework
- Completely rewritten for "Pages First" approach
- New decision tree starting with "Where is this code used?"
- Practical examples for common scenarios
- Golden rule: "When in doubt, keep it in pages/widgets"

#### Anti-Patterns
- **NEW**: "Premature extraction" - the key anti-pattern in v2.1
- Updated cross-import examples with @x notation
- More emphasis on waiting for actual reuse

#### Common Patterns
- Updated "Working with API" pattern to show Pages First approach
- Examples of when to keep code in pages vs when to extract

#### Key Reminders
- Updated to reflect v2.1 principles
- Added 12 key points instead of 7
- Emphasis on Pages First and actual reuse

### 🔧 Tools & Ecosystem

#### Steiger Linter
- Added comprehensive documentation about Steiger
- Installation and usage instructions
- List of what it checks
- Note that it's production-ready

### 📖 Migration Guide

#### FSD v2.0 to v2.1 Migration
- Added dedicated section on migration
- Step-by-step migration process
- Before/after examples
- Clarification that migration is non-breaking

### ✨ Examples & Best Practices

#### Updated Examples
- All code examples updated to reflect v2.1 approach
- More practical, real-world scenarios
- Emphasis on starting simple

#### File Structure Examples
- Pages can now have full segment structure (ui, model, api, lib, config)
- Widgets can have stores and business logic
- Shared can have application-aware code

### 📝 Documentation Improvements

#### README Updates
- Added "What's new in v2.1" section
- Updated all examples to reflect Pages First
- Added information about Steiger linter
- Migration guide from v2.0 to v2.1
- Updated key concepts section

### 🎨 Implementation Checklist
- Updated checklist to reflect v2.1 approach
- Added Steiger configuration step
- Reordered steps to prioritize Pages First

### 🔄 Workflow Changes

The recommended workflow is now:

1. **Start in Pages/Widgets** - Keep code where it's used
2. **Wait for actual reuse** - Don't predict, let patterns emerge
3. **Extract when needed** - Move to features/entities only when you see reuse
4. **Use Steiger** - Enforce rules automatically

## Breaking Changes

None - this is a non-breaking update. All existing FSD v2.0 structures remain valid.

## Deprecations

- **Processes layer** - Should be migrated to Features layer

## Migration from Previous Skill Version

If you were using the previous version of this skill (based on FSD v2.0):

1. Start applying "Pages First" thinking to new code
2. Don't rush to migrate existing code - do it gradually
3. Use Steiger to catch any violations
4. Update your team documentation to reflect v2.1 principles

## Why This Update Matters

### Better Code Cohesion
- Related code stays together instead of being scattered across layers
- Easier to understand and modify features
- Simpler to delete unused code

### Simpler Mental Model
- No need to identify entities and features upfront
- Natural decomposition by pages
- Less cognitive overhead

### Faster Development
- No time wasted on premature abstractions
- Refactor only when you have actual requirements
- Less debate about where code should go

### Team Alignment
- Pages are intuitive for all developers
- Less variation in interpretation
- Fewer conflicts about architecture

## Resources

- [Official FSD v2.1 Documentation](https://feature-sliced.design/)
- [Migration Guide v2.0 → v2.1](https://feature-sliced.design/docs/guides/migration/from-v2-0)
- [Steiger Linter](https://github.com/feature-sliced/steiger)
- [FSD GitHub](https://github.com/feature-sliced/documentation)

## Feedback

If you have suggestions for improving this skill or find any issues, please let the maintainer know.

---

**Version**: 2.1.0  
**Based on**: Feature-Sliced Design v2.1.0  
**Last Updated**: 2024 (based on FSD v2.1 released 2024-10-31)

## Version 2.2.0 - Enforcement workflow + bundled deterministic checker (2026-07-15)

### 🚨 Behavioral change
Invoking the skill on an existing FSD codebase is now **enforcing, not advisory**: the agent must run the bundled checker, fix all ERROR findings autonomously, review all REVIEW flags, and re-run until clean. See "Enforcement Workflow" at the top of SKILL.md.

### 🆕 check-fsd.mjs (zero-dependency, Node >= 18)
- ERROR rules (deterministic, no false positives): FSD-E1 upward imports, FSD-E2 same-layer cross-slice imports, FSD-E3 deep imports bypassing public APIs, FSD-E4 @x misuse, FSD-E5 missing slice index, FSD-E6 deprecated processes/, FSD-E7 layer-level public API, FSD-E8 loose files on layer roots.
- REVIEW rules (deterministic signal, agent judgment): FSD-R1 single-consumer slices ("pages first" fold-back candidates), FSD-R2 god slices, FSD-R3 unknown top-level dirs, FSD-R4 unrecognized shared segments, FSD-R5 @x outside entities, FSD-R6 segmentless slices.
- Tokenizer-based import extraction: no false positives from comments, string/template literals, `Array.from(...)`, or rxjs-style `from(...)`; catches static, side-effect, dynamic, export-from, and type-position imports, via aliases or relative paths.
- Built-in layout variants: views/screens as pages, entries/ as app-tier, generated root modules as universal, test scaffolding excluded by default.
- `fsd.config.json`: aliases, layerAliases, appTierDirs, ignoreTopLevel, includeTests, sharedSegments, godSliceThreshold, acknowledgedReviews and exceptions (both accept {.., reason}); `// fsd-ignore` line suppression; `--json` and `--strict` flags.
- Validated against a synthetic violation fixture (17/17 expected errors, 0 false positives from trap cases) and a 980-file production FSD codebase (47 findings, all manually verified true).

## Version 2.2.1 - Checker hardening on a 3,335-file monorepo (2026-07-15)

Refined against a second, larger production FSD codebase (event_manager web/) to eliminate false positives without losing true positives:

- **FSD-E5 downgrade for dead slices**: slices with zero production source files (tests-only, assets-only, generated-only) are no longer "missing public API" errors — they become FSD-R6 "empty or dead slice" review flags. Eliminated 9 false E5 errors; the 6 remaining E5s (flat slices with real code) all verified true, including one the previous version missed.
- **FSD slice-group support** (one nesting level): a layer child with no index whose children are indexed slice dirs is treated as a group; nested slices get keys like "features/post/like" and follow all slice rules (cross-slice, deep-import, E5, R1/R2). Loose source files at the folder root veto group detection (per FSD spec, groups hold only nested slices) — this distinguishes true groups from slices with sub-barrels (e.g. entities/model-catalog/normalizers/index.ts) and prevented an FP cascade.
- **Root entry modules are now checked as importers**: src-root files (sw.ts, main.tsx) are app-tier consumers — their deep imports into slices are flagged; previously their imports were invisible.
- **FSD-R6 renamed** to "Empty or dead slices" (covers only-index and no-production-code cases).
- Regression-verified: synthetic fixture 21/21 expected errors; WinSTT unchanged at 47 errors / 30 reviews; event_manager 48 errors / 59 reviews, spot-verified true.
