See @AGENTS.md for all project instructions (architecture boundaries, FSD enforcement,
design-system rules, verification gates, and the template rename checklist).

Key points that are easy to miss:

- Frontend is Feature-Sliced Design and it is ENFORCED: run `bun run check:fsd` after
  structural changes; the full skill (with methodology docs) is at
  `.claude/skills/feature-sliced-design/` — invoke it when adding/moving frontend modules.
- `src/bindings.ts` is generated (tauri-specta) — regenerate with
  `cd src-tauri && cargo test export_bindings`; never hand-edit.
- Re-skinning/theming happens only in the `@theme` blocks of `src/app/styles/globals.css`.
