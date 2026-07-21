#!/usr/bin/env node
/**
 * check-fsd.mjs — deterministic Feature-Sliced Design (v2.1) conformance checker.
 *
 * Ships with the feature-sliced-design skill. Zero dependencies, Node >= 18.
 *
 * Usage:
 *   node check-fsd.mjs [srcDir] [--json] [--strict] [--config <path>]
 *
 *   srcDir     Root of the FSD tree (default: ./src)
 *   --json     Machine-readable output (for agents)
 *   --strict   Exit 1 when REVIEW flags exist even if there are no errors
 *   --config   Path to fsd.config.json (default: <cwd>/fsd.config.json,
 *              then <srcDir>/../fsd.config.json)
 *
 * Exit codes: 0 = clean, 1 = errors (or reviews with --strict), 2 = usage/config error.
 *
 * ERROR rules (deterministic — every finding is a genuine FSD violation):
 *   FSD-E1  upward-import          Import from a higher layer than the importer's.
 *   FSD-E2  cross-slice-import     Import between two slices on the same layer (no @x).
 *   FSD-E3  deep-import            Import of another slice's internals, bypassing its
 *                                  public API (index). Shared/app are segment-organized
 *                                  and exempt.
 *   FSD-E4  x-api-misuse           Import of a slice's @x/<consumer> file by anything
 *                                  other than the named consumer slice on the same layer.
 *   FSD-E5  missing-public-api     Slice with production code but no index.(ts|tsx|js|jsx).
 *                                  (Slices with no production code are FSD-R6 instead.)
 *   FSD-E6  deprecated-processes   A processes/ layer exists (removed in FSD v2.1).
 *   FSD-E7  layer-public-api       An index file on a layer root, or an import of a
 *                                  bare layer root (layers must not have a public API).
 *   FSD-E8  file-on-layer-root     A loose source file directly on a sliced layer root
 *                                  or inside a slice-group folder (those hold slices only).
 *
 * REVIEW rules (deterministic signal, human/agent judgment on the verdict):
 *   FSD-R1  single-consumer-slice  Feature/entity/widget consumed by <= 1 other slice —
 *                                  "pages first" fold-back candidate.
 *   FSD-R2  god-slice              Slice above the file-count threshold — split candidate.
 *   FSD-R3  unknown-top-level      Non-layer directory at the src root.
 *   FSD-R4  unknown-shared-segment Unrecognized segment name in shared/.
 *   FSD-R5  x-api-outside-entities @x cross-import API on a layer other than entities.
 *   FSD-R6  empty-slice            Slice containing only an index file, or no production
 *                                  source code at all (tests/assets only) — dead slice?
 *
 * Slice groups: a directory on a sliced layer without its own index, whose children
 * are slices with their own index files (e.g. features/post/like, features/post/comment),
 * is treated as a slice GROUP (one nesting level). Group folders must contain only
 * nested slices; nested slices follow all normal slice rules under the key
 * "layer/group/slice".
 *
 * Suppression:
 *   - `// fsd-ignore` on (or directly above) the import specifier line suppresses that edge.
 *   - fsd.config.json `exceptions` (error edges) / `acknowledgedReviews` (review subjects).
 *
 * Known limitations (documented, deliberate):
 *   - `import.meta.glob(...)` patterns are not resolved (Vite-specific, non-static).
 *   - Dynamic imports inside template-literal interpolations are not seen.
 *   - Specifiers built from variables (`import(x)`) cannot be checked statically.
 *   - Slice groups nest one level; deeper nesting is not modeled.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULTS = {
  srcDir: "src",
  // Import-alias prefixes that map into srcDir. "@/" -> "" means "@/x" == "<src>/x".
  aliases: { "@/": "" },
  // Non-standard layer folder names -> canonical FSD layer.
  layerAliases: { views: "pages", screens: "pages" },
  // Extra top-level dirs treated as app-tier (rank of app, segment-organized,
  // may import everything). Common in multi-window desktop apps.
  appTierDirs: ["entries"],
  // Top-level dirs to skip entirely (no scan, no review flag).
  ignoreTopLevel: ["test", "tests", "__tests__", "e2e", "testing"],
  // Scan *.test.* / *.spec.* / test scaffolding dirs too?
  includeTests: false,
  // Recognized segment names inside shared/ (FSD standard + common infra).
  sharedSegments: [
    "ui", "lib", "api", "config", "model", "types", "assets", "constants",
    "routes", "i18n", "styles", "icons", "fonts", "locales",
  ],
  // FSD-R2 threshold: flag slices with more source files than this.
  godSliceThreshold: 50,
  // Slice keys ("layer/slice") whose REVIEW flags were reviewed and accepted.
  // Entries are strings or { "subject": "...", "reason": "why it was accepted" }.
  acknowledgedReviews: [],
  // Accepted error edges: "relative/file/path.tsx -> import-specifier" ('*' wildcards ok).
  // Entries are strings or { "pattern": "...", "reason": "why it is deliberate" }.
  exceptions: [],
};

const CANONICAL_RANK = { shared: 1, entities: 2, features: 3, widgets: 4, pages: 5, app: 6 };
const SLICED_LAYERS = new Set(["entities", "features", "widgets", "pages"]);
const STANDARD_SEGMENTS = new Set(["ui", "api", "model", "lib", "config"]);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mts|mjs)$/;
const INDEX_RE = /^index\.(ts|tsx|js|jsx|mts|mjs)$/;

function parseArgs(argv) {
  const args = { srcDir: null, json: false, strict: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--config") args.config = argv[++i];
    else if (a.startsWith("--")) fail(`Unknown flag: ${a}`);
    else if (!args.srcDir) args.srcDir = a;
    else fail(`Unexpected argument: ${a}`);
  }
  return args;
}

function fail(msg) {
  console.error(`check-fsd: ${msg}`);
  process.exit(2);
}

function loadConfig(args) {
  const candidates = args.config
    ? [args.config]
    : [
        join(process.cwd(), "fsd.config.json"),
        args.srcDir ? join(resolve(args.srcDir), "..", "fsd.config.json") : null,
      ].filter(Boolean);
  let user = {};
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        user = JSON.parse(readFileSync(p, "utf8"));
      } catch (e) {
        fail(`Cannot parse config ${p}: ${e.message}`);
      }
      break;
    }
    if (args.config) fail(`Config not found: ${p}`);
  }
  const cfg = { ...DEFAULTS, ...user };
  // Merge (not replace) additive lists/maps the user is most likely extending.
  cfg.layerAliases = { ...DEFAULTS.layerAliases, ...(user.layerAliases ?? {}) };
  cfg.aliases = { ...DEFAULTS.aliases, ...(user.aliases ?? {}) };
  for (const k of ["sharedSegments", "ignoreTopLevel", "appTierDirs"]) {
    if (user[k]) cfg[k] = [...new Set([...DEFAULTS[k], ...user[k]])];
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

function isTestPath(rel) {
  return (
    /[.-](test|spec)\.(ts|tsx|js|jsx|mts|mjs)$/.test(rel) ||
    /(^|\/)(test|tests|__tests__|__mocks__)\//.test(rel)
  );
}

function walk(dir, cfg, rel = "", out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const r = rel ? `${rel}/${entry}` : entry;
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      if (!rel && cfg.ignoreTopLevel.includes(entry)) continue;
      walk(abs, cfg, r, out);
    } else if (SOURCE_EXT.test(entry) && !entry.endsWith(".d.ts")) {
      if (!cfg.includeTests && isTestPath(r)) continue;
      out.push(r);
    }
  }
  return out;
}

/**
 * Single-pass tokenizer: extract import specifiers with line numbers.
 * Only string literals in genuine import positions are returned:
 *   import ... from "x" | export ... from "x" | import "x" | import("x")
 * Comments, string contents, and template-literal contents can never produce
 * a match (no false positives from code samples embedded in strings).
 */
function extractImportEdges(src) {
  const edges = [];
  let i = 0;
  let line = 1;
  let state = "code"; // code | line | block | tpl
  let ctx = ""; // recent non-literal code, used for import-context detection

  const pushCtx = (c) => {
    ctx += c;
    if (ctx.length > 64) ctx = ctx.slice(-64);
  };

  const isImportContext = () => {
    let s = ctx.replace(/\s+$/, "");
    let paren = false;
    if (s.endsWith("(")) {
      paren = true;
      s = s.slice(0, -1).replace(/\s+$/, "");
    }
    const m = s.match(/([A-Za-z_$][\w$]*)$/);
    if (!m) return false;
    const kw = m[1];
    // `from "..."` only in import/export statements (never parenthesized);
    // `import "..."` (side-effect) and `import("...")` (dynamic).
    if (paren ? kw !== "import" : kw !== "from" && kw !== "import") return false;
    const before = s[s.length - kw.length - 1];
    if (before !== undefined && /[\w$.]/.test(before)) return false; // Array.from, foo.import
    return true;
  };

  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (state === "code") {
      if (c === "\n") line++;
      if (c === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (c === "'" || c === '"') {
        const quote = c;
        let j = i + 1;
        let str = "";
        while (j < n) {
          const ch = src[j];
          if (ch === "\\") { str += ch + (src[j + 1] ?? ""); j += 2; continue; }
          if (ch === quote || ch === "\n") break;
          str += ch;
          j++;
        }
        if (isImportContext()) edges.push({ spec: str, line });
        pushCtx(" str ");
        i = j + 1;
        continue;
      }
      if (c === "`") { state = "tpl"; pushCtx(" tpl "); i++; continue; }
      pushCtx(c);
      i++;
      continue;
    }
    if (c === "\n") line++;
    if (state === "line") {
      if (c === "\n") state = "code";
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; i += 2; continue; }
      i++;
      continue;
    }
    // state === "tpl"
    if (c === "\\") { i += 2; continue; }
    if (c === "`") state = "code";
    i++;
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

/**
 * Classify an src-relative path (source file or normalized import target)
 * into the FSD layer model. `groups` is the set of slice-group keys
 * ("layer/groupDir") discovered structurally.
 */
function classify(relPath, cfg, groups) {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const top = parts[0];
  if (parts.length === 1) {
    // Loose module at src root (e.g. generated bindings, sw.ts): universal target.
    return { kind: "root", name: top.replace(SOURCE_EXT, "") };
  }
  const canon = cfg.layerAliases[top] ?? top;
  if (canon === "processes") return { kind: "layer", layer: top, canon, rank: 6, sliced: false, parts, rest: parts.slice(1) };
  if (cfg.appTierDirs.includes(top)) {
    return { kind: "layer", layer: top, canon: "app", rank: CANONICAL_RANK.app, sliced: false, parts, rest: parts.slice(1) };
  }
  const rank = CANONICAL_RANK[canon];
  if (rank === undefined) return { kind: "unknown", name: top, parts };
  const sliced = SLICED_LAYERS.has(canon);
  const info = { kind: "layer", layer: top, canon, rank, sliced, parts };
  if (sliced) {
    if (groups.has(`${top}/${parts[1]}`)) {
      if (parts.length === 2) {
        // Bare group root — nothing importable lives here.
        info.isGroupRoot = true;
        info.slice = parts[1];
        info.rest = [];
        info.isRealSlice = false;
        return info;
      }
      info.slice = `${parts[1]}/${parts[2].replace(SOURCE_EXT, "")}`;
      info.rest = parts.slice(3);
      // "features/group/loose.ts" is a stray file (FSD-E8), not a nested slice.
      info.isRealSlice = parts.length > 3 || !SOURCE_EXT.test(parts[2]);
    } else {
      info.slice = parts[1].replace(SOURCE_EXT, "");
      info.rest = parts.slice(2);
      // "widgets/loose.ts" is a layer-root file (FSD-E8), not a slice.
      info.isRealSlice = parts.length > 2 || !SOURCE_EXT.test(parts[1]);
    }
  } else {
    info.rest = parts.slice(1);
  }
  return info;
}

/** Normalize an import target path: strip query/hash, extension, trailing /index. */
function normalizeTarget(rel) {
  return rel
    .replace(/[?#].*$/, "")
    .replace(SOURCE_EXT, "")
    .replace(/\/index$/, "");
}

/** Resolve an import specifier to an src-relative path, or null if external. */
function resolveSpec(spec, fileRel, srcAbs, cfg) {
  const clean = spec.replace(/[?#].*$/, "");
  for (const [prefix, mapped] of Object.entries(cfg.aliases)) {
    if (clean.startsWith(prefix)) return normalizeTarget(mapped + clean.slice(prefix.length));
  }
  if (clean.startsWith("./") || clean.startsWith("../")) {
    const abs = resolve(srcAbs, dirname(fileRel), clean).replaceAll("\\", "/");
    const root = resolve(srcAbs).replaceAll("\\", "/");
    if (!abs.startsWith(root + "/")) return null; // escapes the src tree
    return normalizeTarget(abs.slice(root.length + 1));
  }
  return null; // package import
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

function compileExceptions(patterns) {
  return patterns.map((entry) => {
    const p = typeof entry === "string" ? entry : entry.pattern;
    const rx = p
      .split("*")
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${rx}$`);
  });
}

function run(cfg, srcAbs) {
  const errors = []; // {rule, file, line, spec, message}
  const reviews = []; // {rule, subject, message}
  const exceptionRes = compileExceptions(cfg.exceptions);
  const acknowledged = new Set(cfg.acknowledgedReviews.map((a) => (typeof a === "string" ? a : a.subject)));
  const consumers = new Map(); // slice key -> Set of importer keys
  const sliceFiles = new Map(); // slice key -> production source file count
  const rootModules = new Set();
  const groups = new Set(); // "layer/groupDir"
  const sliceRegistry = new Map(); // slice key -> {hasIndex, segmentEntries}
  const xApiFiles = [];

  const addError = (rule, file, line, spec, message) => {
    if (spec && exceptionRes.some((re) => re.test(`${file} -> ${spec}`))) return;
    errors.push({ rule, file, line, spec, message });
  };

  // Group-detection exclusions: a child dir with an index file only counts as a
  // nested slice if its name isn't a segment or layer name (those indicate the
  // parent is a slice missing its root index, not a group).
  const groupExclude = new Set([
    ...STANDARD_SEGMENTS,
    ...cfg.sharedSegments,
    ...Object.keys(CANONICAL_RANK),
    ...Object.keys(cfg.layerAliases),
    "@x",
  ]);

  const registerSlice = (key, dirAbs) => {
    const entries = readdirSync(dirAbs);
    const hasIndex = entries.some((f) => INDEX_RE.test(f));
    const segmentEntries = entries.filter((f) => !INDEX_RE.test(f) && f !== "@x" && !f.endsWith(".d.ts"));
    sliceRegistry.set(key, { hasIndex, segmentEntries });
    const xDir = join(dirAbs, "@x");
    if (entries.includes("@x") && statSync(xDir).isDirectory()) {
      for (const xf of readdirSync(xDir)) {
        if (SOURCE_EXT.test(xf)) xApiFiles.push({ key, consumer: xf.replace(SOURCE_EXT, "") });
      }
    }
  };

  // --- structural pass -------------------------------------------------------
  for (const entry of readdirSync(srcAbs)) {
    const abs = join(srcAbs, entry);
    if (statSync(abs).isDirectory()) {
      if (cfg.ignoreTopLevel.includes(entry) || entry === "node_modules") continue;
      const canon = cfg.layerAliases[entry] ?? entry;
      if (canon === "processes") {
        addError("FSD-E6", entry, 0, "", "processes/ layer is deprecated in FSD v2.1 — move code into features/ (with app/ glue)");
        continue;
      }
      if (!(canon in CANONICAL_RANK) && !cfg.appTierDirs.includes(entry)) {
        reviews.push({ rule: "FSD-R3", subject: entry, message: "top-level directory is not an FSD layer — map it via layerAliases/appTierDirs, ignore it via ignoreTopLevel, or restructure" });
        continue;
      }
      if (SLICED_LAYERS.has(canon)) {
        for (const child of readdirSync(abs)) {
          const childAbs = join(abs, child);
          if (statSync(childAbs).isDirectory()) {
            const sliceKey = `${entry}/${child}`;
            const childEntries = readdirSync(childAbs);
            const hasIndex = childEntries.some((f) => INDEX_RE.test(f));
            // Slice-group detection. Per FSD, group folders contain ONLY nested
            // slices: no own index AND no loose source files at the root (a dir
            // with loose files + an indexed subfolder is a slice with a
            // sub-barrel, e.g. entities/foo/{utils.ts,normalizers/index.ts}).
            const looseSource = childEntries.some(
              (f) => SOURCE_EXT.test(f) && !f.endsWith(".d.ts") && statSync(join(childAbs, f)).isFile()
            );
            const nestedSliceDirs = hasIndex || looseSource
              ? []
              : childEntries.filter((g) => {
                  if (groupExclude.has(g)) return false;
                  const gAbs = join(childAbs, g);
                  return statSync(gAbs).isDirectory() && readdirSync(gAbs).some((f) => INDEX_RE.test(f));
                });
            if (nestedSliceDirs.length > 0) {
              groups.add(sliceKey);
              for (const g of childEntries) {
                const gAbs = join(childAbs, g);
                if (statSync(gAbs).isDirectory()) registerSlice(`${sliceKey}/${g}`, gAbs);
              }
            } else {
              registerSlice(sliceKey, childAbs);
            }
          } else if (INDEX_RE.test(child)) {
            addError("FSD-E7", `${entry}/${child}`, 0, "", "layers must not have a public API — remove the layer-root index file");
          } else if (SOURCE_EXT.test(child) && !child.endsWith(".d.ts")) {
            addError("FSD-E8", `${entry}/${child}`, 0, "", "loose file on a sliced layer root — move it into a slice");
          }
        }
      }
      if (canon === "shared") {
        for (const child of readdirSync(abs)) {
          if (!statSync(join(abs, child)).isDirectory()) continue;
          if (!cfg.sharedSegments.includes(child) && !acknowledged.has(`shared/${child}`)) {
            reviews.push({ rule: "FSD-R4", subject: `shared/${child}`, message: "unrecognized shared segment — verify it is infrastructure (no business logic), then add it to sharedSegments or acknowledgedReviews in fsd.config.json" });
          }
        }
      }
    } else if (SOURCE_EXT.test(entry) && !entry.endsWith(".d.ts")) {
      rootModules.add(entry.replace(SOURCE_EXT, ""));
    }
  }
  for (const x of xApiFiles) {
    const layer = x.key.split("/")[0];
    if ((cfg.layerAliases[layer] ?? layer) !== "entities" && !acknowledged.has(x.key)) {
      reviews.push({ rule: "FSD-R5", subject: `${x.key}/@x/${x.consumer}`, message: "@x cross-import API outside the entities layer — FSD reserves @x for entity relationships" });
    }
  }

  // --- import pass -------------------------------------------------------------
  const files = walk(srcAbs, cfg, "", []).map((f) => f.replaceAll("\\", "/")).sort();
  for (const file of files) {
    let me = classify(file, cfg, groups);
    if (!me || me.kind === "unknown" || me.canon === "processes") continue;
    if (me.kind === "root") {
      // Root-level entry modules (sw.ts, main.tsx, generated bindings) sit outside
      // the layer system but are still consumers: app-tier rank, public-API rules apply.
      me = { kind: "layer", layer: me.name, canon: "app", rank: CANONICAL_RANK.app, sliced: false, rest: [] };
    }
    if (me.sliced && me.slice && me.isRealSlice) {
      const key = `${me.layer}/${me.slice}`;
      sliceFiles.set(key, (sliceFiles.get(key) ?? 0) + 1);
    }
    const raw = readFileSync(join(srcAbs, file), "utf8");
    const rawLines = raw.split("\n");
    for (const { spec, line } of extractImportEdges(raw)) {
      const targetRel = resolveSpec(spec, file, srcAbs, cfg);
      if (targetRel === null || targetRel === "") continue;
      const target = classify(targetRel, cfg, groups);
      if (!target || target.kind === "unknown" || target.isGroupRoot) continue;

      // Suppression: `fsd-ignore` on the specifier line or the line above.
      const here = rawLines[line - 1] ?? "";
      const above = rawLines[line - 2] ?? "";
      if (here.includes("fsd-ignore") || above.includes("fsd-ignore")) continue;

      if (target.kind === "root") {
        // "@/name" with no path: generated root module (universal) or a layer root.
        if (!rootModules.has(target.name)) {
          const canon = cfg.layerAliases[target.name] ?? target.name;
          if (SLICED_LAYERS.has(canon)) {
            addError("FSD-E7", file, line, spec, "import of a bare layer root — import a specific slice's public API instead");
          }
        }
        continue;
      }

      const importerKey = me.sliced && me.slice ? `${me.layer}/${me.slice}` : me.layer;
      if (target.sliced && target.slice) {
        const tKey = `${target.layer}/${target.slice}`;
        if (importerKey !== tKey) {
          if (!consumers.has(tKey)) consumers.set(tKey, new Set());
          consumers.get(tKey).add(importerKey);
        }
      }

      // @x cross-import API path?
      if (target.sliced && target.rest[0] === "@x") {
        const consumerName = (target.rest[1] ?? "").replace(SOURCE_EXT, "");
        const meName = me.slice ? me.slice.split("/").pop() : "";
        const sanctioned = me.sliced && me.canon === target.canon && meName === consumerName;
        if (!sanctioned) {
          addError("FSD-E4", file, line, spec, `the @x API of ${target.layer}/${target.slice} is reserved for the "${consumerName}" slice on the same layer`);
        }
        continue;
      }

      // FSD-E1: upward import
      if (target.rank > me.rank) {
        addError("FSD-E1", file, line, spec, `${me.layer}/ (rank ${me.rank}) must not import from ${target.layer}/ (rank ${target.rank}) — invert the dependency or move the shared code down`);
        continue;
      }
      // FSD-E2: same-layer cross-slice
      if (me.sliced && target.sliced && me.canon === target.canon && me.slice !== target.slice) {
        addError("FSD-E2", file, line, spec, `cross-import between "${me.slice}" and "${target.slice}" on the ${me.canon} layer — compose on a higher layer, extract shared code downward, or (entities only) use @x`);
        continue;
      }
      // FSD-E3: deep import bypassing a foreign slice's public API
      if (target.sliced && target.slice && target.rest.length > 0) {
        const sameSlice = me.sliced && me.layer === target.layer && me.slice === target.slice;
        if (!sameSlice) {
          addError("FSD-E3", file, line, spec, `bypasses the public API of ${target.layer}/${target.slice} — re-export from its index and import the slice root`);
        }
      }
    }
  }

  // --- post-pass rules (need the production file counts) -----------------------
  for (const [key, info] of [...sliceRegistry.entries()].sort()) {
    const prod = sliceFiles.get(key) ?? 0;
    if (!info.hasIndex) {
      if (prod > 0) {
        addError("FSD-E5", key, 0, "", "slice has no public API (index file)");
      } else if (!acknowledged.has(key)) {
        reviews.push({ rule: "FSD-R6", subject: key, message: "slice contains no production source code (tests or assets only) — dead slice or misplaced assets?" });
      }
    } else if (info.segmentEntries.length === 0 && !acknowledged.has(key)) {
      reviews.push({ rule: "FSD-R6", subject: key, message: "slice contains only an index file — dead abstraction or misplaced code?" });
    }
  }
  for (const [key, count] of [...sliceFiles.entries()].sort((a, b) => b[1] - a[1])) {
    if (count > cfg.godSliceThreshold && !acknowledged.has(key)) {
      reviews.push({ rule: "FSD-R2", subject: key, message: `${count} source files (threshold ${cfg.godSliceThreshold}) — consider splitting into focused slices` });
    }
  }
  for (const key of [...sliceFiles.keys()].sort()) {
    const layer = key.split("/")[0];
    const canon = cfg.layerAliases[layer] ?? layer;
    if (!["features", "entities", "widgets"].includes(canon)) continue;
    if (acknowledged.has(key)) continue;
    const c = consumers.get(key) ?? new Set();
    if (c.size <= 1) {
      const who = c.size === 0 ? "no other slice imports it" : `only ${[...c][0]} imports it`;
      reviews.push({ rule: "FSD-R1", subject: key, message: `${who} — "pages first": consider folding it into its consumer, or acknowledge in fsd.config.json if intentionally standalone (e.g. wired via app/entries/IPC)` });
    }
  }

  return { files: files.length, errors, reviews };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const RULE_TITLES = {
  "FSD-E1": "Upward imports (layer order violated)",
  "FSD-E2": "Cross-slice imports on the same layer",
  "FSD-E3": "Deep imports bypassing a slice's public API",
  "FSD-E4": "@x cross-import API misuse",
  "FSD-E5": "Slices without a public API (index file)",
  "FSD-E6": "Deprecated processes/ layer",
  "FSD-E7": "Layer-level public API",
  "FSD-E8": "Loose files on layer/group roots",
  "FSD-R1": "Single-consumer slices (pages-first fold-back candidates)",
  "FSD-R2": "God slices (file count over threshold)",
  "FSD-R3": "Unknown top-level directories",
  "FSD-R4": "Unrecognized shared segments",
  "FSD-R5": "@x outside the entities layer",
  "FSD-R6": "Empty or dead slices",
};

function printGrouped(list, kind) {
  const groups = new Map();
  for (const item of list) {
    if (!groups.has(item.rule)) groups.set(item.rule, []);
    groups.get(item.rule).push(item);
  }
  for (const [rule, items] of [...groups.entries()].sort()) {
    console.log(`\n${kind} ${rule}: ${RULE_TITLES[rule]} (${items.length})`);
    for (const it of items) {
      if (it.subject !== undefined) {
        console.log(`  ${it.subject}`);
      } else {
        const loc = it.line ? `${it.file}:${it.line}` : it.file;
        console.log(`  ${loc}${it.spec ? `  ->  ${it.spec}` : ""}`);
      }
      console.log(`      ${it.message}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args);
  const srcDir = args.srcDir ?? cfg.srcDir;
  const srcAbs = resolve(srcDir);
  if (!existsSync(srcAbs) || !statSync(srcAbs).isDirectory()) fail(`src directory not found: ${srcAbs}`);

  const result = run(cfg, srcAbs);
  const { errors, reviews } = result;

  if (args.json) {
    console.log(JSON.stringify({ src: srcAbs, filesScanned: result.files, errors, reviews }, null, 2));
  } else {
    console.log(`check-fsd: scanned ${result.files} files under ${srcDir}`);
    if (errors.length) printGrouped(errors, "ERROR");
    if (reviews.length) printGrouped(reviews, "REVIEW");
    console.log(`\nresult: ${errors.length} error(s), ${reviews.length} review flag(s)`);
    if (!errors.length && !reviews.length) console.log("FSD conformance: clean.");
  }
  process.exit(errors.length ? 1 : args.strict && reviews.length ? 1 : 0);
}

main();
