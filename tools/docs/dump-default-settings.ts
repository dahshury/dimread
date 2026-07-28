/**
 * Print the app's DEFAULT settings tree as JSON.
 *
 * `tools/docs/capture-screenshots.mjs` runs under Node (Playwright's CDP pipe
 * transport does not survive Bun's child-process plumbing on Windows), and Node
 * cannot import the renderer's TypeScript zod schema directly — so the capture
 * script shells out to Bun for this one value.
 *
 * Reading the defaults from the schema instead of hand-writing them is the
 * whole point: the documentation screenshots then show what a fresh install
 * actually looks like, and drift becomes impossible.
 *
 *   bun tools/docs/dump-default-settings.ts
 */
import { appSettingsSchema } from "../../src/shared/config/settings-schema";

process.stdout.write(JSON.stringify(appSettingsSchema.parse({})));
