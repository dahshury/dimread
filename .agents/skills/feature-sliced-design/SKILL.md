---
name: feature-sliced-design
description: Apply Feature-Sliced Design (FSD) v2.1 architectural methodology to frontend projects. Use when organizing code structure, decomposing features, creating new components or features, refactoring existing codebases, or when users mention "FSD", "Feature-Sliced", layers, slices, or frontend architecture patterns. On an existing FSD codebase, this skill is enforcing, not just advisory - run the bundled deterministic checker (check-fsd.mjs in this skill's directory), fix every ERROR finding autonomously, review every REVIEW flag, and re-run until clean.
---

# Feature-Sliced Design (FSD) Skill - v2.1.0

An architectural methodology skill for scaffolding and organizing frontend applications using Feature-Sliced Design principles.

## Overview

Feature-Sliced Design v2.1 is a compilation of rules and conventions for organizing frontend code to make projects more understandable, maintainable, and stable in the face of changing business requirements.

**Version 2.1 introduces the "Pages First" approach** - keeping more code in pages and widgets rather than prematurely extracting it to features and entities.

## Enforcement Workflow — MANDATORY on existing FSD codebases

This skill ships with a deterministic conformance checker, **`check-fsd.mjs`**, in the same directory as this SKILL.md (the skill's base directory, shown when the skill loads). When this skill is invoked on a project that already has an FSD tree, do **not** stop at advice: **scan → fix errors autonomously → review flags → re-run until clean.** Skip this workflow only when scaffolding a brand-new project or answering a purely conceptual question.

### Step 1 — Scan

```bash
node "<skill-base-dir>/check-fsd.mjs" <srcDir>          # human-readable
node "<skill-base-dir>/check-fsd.mjs" <srcDir> --json   # machine-readable
```

Exit codes: `0` clean, `1` errors found (`--strict` also fails on REVIEW flags), `2` usage/config error. The checker is zero-dependency (Node >= 18) and auto-detects common layout variants: `views/`/`screens/` as the pages layer, `entries/` as app-tier (multi-window apps), root entry modules (e.g. `sw.ts`, generated `bindings.ts`) as app-tier consumers/universal targets, FSD slice groups (one nesting level — a group folder holds only nested slices, never loose files), and top-level `test/` dirs ignored. Other layouts are configured via `fsd.config.json` (see below).

Findings come in two tiers:

- **`FSD-E*` ERRORS are deterministic — every finding is a genuine FSD violation. Fix all of them autonomously; do not ask for permission per finding.**
- **`FSD-R*` REVIEW flags are accurate facts whose verdict needs judgment. Review each one yourself (read the flagged code), then either restructure or acknowledge it in `fsd.config.json` with a reason.**

### Step 2 — Fix every ERROR autonomously

| Rule | Violation | How to fix |
|------|-----------|------------|
| FSD-E1 | Upward import (lower layer imports higher) | Move the imported code down to a layer at or below the importer (usually `shared/` or the importer's own layer), or invert the dependency: let the higher layer pass it down via props/composition/DI. Never "fix" by re-exporting from a lower layer. |
| FSD-E2 | Cross-slice import on the same layer | In order of preference: (a) hoist the composition to the nearest higher layer that already knows both slices; (b) extract the genuinely shared code down to `entities/` or `shared/`; (c) entities with a real business relationship only: create an `@x` cross-import API. |
| FSD-E3 | Deep import bypassing a slice's public API | Default: add the needed export to the target slice's `index` and import the slice root. But first check whether the importer is reaching for something that *shouldn't* be public — if so, move that code to the consumer or down to `shared/` instead of widening the API. |
| FSD-E4 | `@x` API imported by the wrong consumer | Either route the importer through the target slice's regular public API, or (if the relationship is real) add a properly named `@x/<importer-slice>.ts` file. |
| FSD-E5 | Slice with production code but no public API | Create `index.ts` exporting exactly the surface other slices actually use (search usages first; don't `export *`). Slices with *no* production code are FSD-R6 review flags instead. |
| FSD-E6 | Deprecated `processes/` layer | Dissolve into `features/` with `app/`-layer glue. |
| FSD-E7 | Layer-level public API (layer-root index, or bare layer import) | Delete the layer index; rewrite importers against specific slices' public APIs. |
| FSD-E8 | Loose file on a sliced layer root | Move it into the slice it serves (or create one). |

After each batch of moves, update all import sites and re-run the checker.

### Step 3 — Review every REVIEW flag

These are the findings a script cannot judge — that's your job. Read the flagged code before deciding.

| Rule | Signal | Your review decision |
|------|--------|----------------------|
| FSD-R1 | Slice consumed by ≤ 1 other slice | "Pages first": if it's small and its one consumer is a page/widget, fold it into that consumer's segments. Keep it standalone when it's wired through `app/`/entries/IPC/background processes, or reuse is concretely planned — then acknowledge with that reason. |
| FSD-R2 | God slice (file count over threshold) | Look for sub-domain clusters inside the slice and split along them. If it's genuinely one cohesive domain, acknowledge with a reason. |
| FSD-R3 | Unknown top-level directory | Map it (`layerAliases`/`appTierDirs`), ignore it (`ignoreTopLevel`), or restructure it into a layer. |
| FSD-R4 | Unrecognized shared segment | Verify it contains only infrastructure (no business logic). If legit, add to `sharedSegments`; if it's business logic, move it to `entities/` or the consumer. |
| FSD-R5 | `@x` outside the entities layer | FSD reserves `@x` for entities. Restructure to higher-layer composition, or acknowledge if the team deliberately extends `@x`. |
| FSD-R6 | Empty or dead slice (only an index file, or no production code at all — tests/assets only) | Dead abstraction — delete it, move real code in, or relocate stray assets. |

Record accepted flags in `fsd.config.json` so they don't resurface:

```json
{
  "acknowledgedReviews": [
    { "subject": "features/push-to-talk", "reason": "wired via IPC hotkey pipeline, not UI imports" }
  ]
}
```

### Step 4 — Re-run until clean, then verify

Re-run the checker until it reports `0 error(s)` and every remaining REVIEW flag is acknowledged. Then run the project's own gates (typecheck, lint, tests) to prove the restructuring broke nothing, and report to the user: what was fixed, what was acknowledged and why, and anything deferred.

### Rules of engagement

- **Never** edit `check-fsd.mjs` to make findings pass, and never blanket-except a whole rule.
- Escape hatches — `// fsd-ignore` on an import line, or `exceptions` in `fsd.config.json` — are for deliberate, documented violations only (always include a `reason`), never for silencing noise.
- Known blind spots you must cover manually when relevant: `import.meta.glob(...)` patterns, dynamic imports with variable specifiers, and semantic placement questions (is this really an entity? is that business logic in `shared/`?). The Decision Framework below governs those.

### Configuration — `fsd.config.json` (project root, all keys optional)

| Key | Default | Purpose |
|-----|---------|---------|
| `srcDir` | `"src"` | Root of the FSD tree |
| `aliases` | `{"@/": ""}` | Import-alias prefixes mapping into srcDir |
| `layerAliases` | `views`/`screens` → `pages` | Non-standard layer folder names |
| `appTierDirs` | `["entries"]` | Extra top-level dirs treated as app-tier |
| `ignoreTopLevel` | `test`, `tests`, … | Top-level dirs to skip entirely |
| `includeTests` | `false` | Also check `*.test.*`/`test/` scaffolding |
| `sharedSegments` | `ui`, `lib`, `api`, `config`, … | Recognized `shared/` segment names |
| `godSliceThreshold` | `50` | FSD-R2 file-count threshold |
| `acknowledgedReviews` | `[]` | Reviewed-and-accepted REVIEW subjects (string or `{subject, reason}`) |
| `exceptions` | `[]` | Accepted error edges `"file -> spec"`, `*` wildcards (string or `{pattern, reason}`) |

User-supplied lists **extend** the defaults (they don't replace them).

## Core Principles

### The "Pages First" Approach (FSD v2.1)

**The fundamental principle of FSD v2.1: Keep code where it's used until you need to reuse it.**

Instead of immediately extracting everything into entities and features, start by keeping code in pages and widgets. Only move code to lower layers when you actually need to reuse it.

#### What stays in Pages and Widgets:

✅ **Large UI blocks** that are only used on one page
✅ **Forms and their validation logic** specific to a page
✅ **Data fetching and state management** for page-specific data
✅ **Business logic** that serves only this page/widget
✅ **API interactions** needed only here

#### When to extract to lower layers:

- **To Shared**: When you need the same *infrastructure* in multiple places (modal manager, date formatter, UI components)
- **To Entities**: When you have a clear *business domain model* that's used across multiple features
- **To Features**: When you have a complete *user interaction* that's reused in multiple places

#### Why "Pages First"?

1. **Better code cohesion** - related code stays together
2. **Easier to delete** - unused code is right there with its usage
3. **Less abstraction overhead** - no need to identify entities/features prematurely
4. **Natural decomposition** - pages are intuitive to understand
5. **Faster development** - no time wasted on premature optimization

### 1. Layered Architecture (Vertical Organization)

FSD uses **6 active standardized layers** organized by responsibility and dependencies. Layers are ordered from most specific (top) to most generic (bottom):

```
app/           ← Application initialization, providers, global styles
pages/         ← Full page compositions with their own logic, routing
widgets/       ← Large composite UI blocks with their own logic
features/      ← Reusable user interactions and business features
entities/      ← Reusable business entities (user, product, order)
shared/        ← Reusable infrastructure code (UI kit, utils, API)
```

**Note**: Historically, FSD included `processes/` as a 7th layer, but it is **deprecated** in v2.1. If you're using it, move the code to `features/` with help from `app/` if needed.

**Import Rule**: A module can only import from layers **strictly below** it.
- ✅ `features/` → `entities/`, `shared/`
- ✅ `pages/` → `widgets/`, `features/`, `entities/`, `shared/`
- ❌ `entities/` → `features/` (upward import)
- ❌ `features/comments/` → `features/posts/` (same-layer cross-import)

### 2. Slices (Horizontal Organization)

Slices group code by **business domain meaning**. Each slice represents a specific business concept:

```
features/
  ├── auth/           ← Authentication feature
  ├── comments/       ← Comments functionality
  └── post-editor/    ← Post editing feature

entities/
  ├── user/           ← User business entity
  ├── product/        ← Product business entity
  └── order/          ← Order business entity
```

**Key Rules**:
- Slices must be **independent** from other slices on the same layer (zero coupling)
- Slices should contain **most code related to their primary goal** (high cohesion)
- Slice names are **not standardized** - they reflect your business domain

### 3. Segments (Technical Organization)

Segments group code within slices by **technical purpose**:

```
features/
  └── auth/
      ├── ui/         ← React components, styles, formatters
      ├── api/        ← API requests, data types, mappers
      ├── model/      ← State management, business logic, stores
      ├── lib/        ← Internal utilities for this slice
      ├── config/     ← Configuration, feature flags
      └── index.ts    ← Public API (exports only what other slices need)
```

**Standard Segments**:
- `ui` - UI components, styles, date formatters
- `api` - Backend interactions, request functions, data types
- `model` - Data models, state stores, business logic
- `lib` - Utility functions needed by this slice
- `config` - Configuration files, feature flags

### 4. Public API

Every slice must define a **public API** through an index file:

```typescript
// features/auth/index.ts
export { LoginForm } from './ui/LoginForm';
export { useAuth } from './model/useAuth';
export { loginUser } from './api/loginUser';
// Internal files not exported remain private to the slice
```

**Rule**: Modules outside a slice can **only import from the public API**, not from internal files.

#### Public API for Cross-Imports (@x notation)

**New in v2.1**: You can now create explicit connections between slices on the same layer (typically entities) using the `@x` notation.

This allows entities to reference each other when there's a legitimate business relationship:

```typescript
// entities/user/index.ts
export { UserCard } from './ui/UserCard';
export { userModel } from './model';

// entities/user/@x/order.ts
// Cross-import API specifically for the order entity
export { UserOrderHistory } from './ui/UserOrderHistory';
export { getUserOrders } from './api/getUserOrders';

// entities/order/index.ts
import { UserOrderHistory } from '@/entities/user/@x/order';
// Now order can import from user's cross-import API
```

**When to use cross-imports**:
- There's a clear business relationship between entities (e.g., User and Order)
- The dependency is bidirectional or circular in the business domain
- You want to keep the code together while acknowledging the relationship

**Important**: Regular cross-imports between slices (without `@x`) are still not allowed. Use `@x` notation to make cross-dependencies explicit and controlled.

## Layer Definitions & Examples

### App Layer
Application-wide settings, providers, routing setup.

```
app/
  ├── providers/      ← Redux Provider, React Query, Theme Provider
  ├── styles/         ← Global CSS, resets, theme variables
  ├── index.tsx       ← Application entry point
  └── router.tsx      ← Route configuration
```

### Pages Layer
Route-level compositions with their own logic and data management.

```
pages/
  ├── home/
  │   ├── ui/
  │   │   ├── HomePage.tsx
  │   │   ├── HeroSection.tsx      ← Large UI blocks
  │   │   └── FeaturesGrid.tsx
  │   ├── model/
  │   │   └── useHomeData.ts       ← Page-specific state
  │   ├── api/
  │   │   └── fetchHomeData.ts     ← Page-specific API
  │   └── index.ts
  ├── profile/
  │   ├── ui/
  │   │   ├── ProfilePage.tsx
  │   │   ├── ProfileForm.tsx      ← Forms specific to this page
  │   │   └── ProfileStats.tsx
  │   ├── model/
  │   │   ├── profileStore.ts      ← State for profile page
  │   │   └── validation.ts        ← Form validation
  │   ├── api/
  │   │   ├── updateProfile.ts
  │   │   └── fetchProfile.ts
  │   └── index.ts
  └── settings/
```

**v2.1 Approach**: Pages can now contain:
- ✅ Large UI blocks used only on this page
- ✅ Forms and their validation logic
- ✅ Data fetching and state management
- ✅ Business logic that serves only this page
- ✅ API interactions specific to this page

**Only extract to lower layers when you need to reuse the code elsewhere.**

### Widgets Layer
Complex, composite UI blocks with their own logic, used across multiple pages.

```
widgets/
  ├── header/
  │   ├── ui/
  │   │   ├── Header.tsx
  │   │   ├── Navigation.tsx
  │   │   └── UserMenu.tsx
  │   ├── model/
  │   │   └── headerStore.ts       ← Widget state
  │   ├── api/
  │   │   └── fetchNotifications.ts ← Widget-specific API
  │   └── index.ts
  ├── sidebar/
  │   ├── ui/
  │   ├── model/
  │   │   └── sidebarState.ts
  │   └── index.ts
  └── footer/
```

**v2.1 Approach**: Widgets are no longer just compositional blocks. They can contain:
- ✅ UI components of the widget
- ✅ Widget-specific state management
- ✅ Business logic that serves the widget
- ✅ API interactions the widget needs
- ✅ Internal utilities

**Only extract code to entities/features when other widgets or pages need it.**

### Features Layer
**Reusable user interactions** and complete business features used in multiple places.

```
features/
  ├── auth/
  │   ├── ui/
  │   │   ├── LoginForm.tsx
  │   │   └── RegisterForm.tsx
  │   ├── model/
  │   │   └── useAuth.ts
  │   ├── api/
  │   │   ├── login.ts
  │   │   └── register.ts
  │   └── index.ts
  ├── add-to-cart/
  ├── like-post/
  └── comment-create/
```

**v2.1 Approach**: Only create a feature when:
- ✅ The user interaction is used on **multiple pages/widgets**
- ✅ It's a complete, self-contained user action
- ✅ It has clear business value

**Don't create features prematurely.** If a user interaction is only used in one place, keep it in the page or widget until you actually need to reuse it.

### Entities Layer
**Reusable business entities** - the core domain models used across the application.

```
entities/
  ├── user/
  │   ├── ui/
  │   │   ├── UserCard.tsx
  │   │   └── UserAvatar.tsx
  │   ├── model/
  │   │   ├── types.ts
  │   │   └── userStore.ts
  │   ├── api/
  │   │   └── userApi.ts
  │   ├── @x/
  │   │   └── order.ts             ← Cross-import API for order
  │   └── index.ts
  ├── product/
  └── order/
```

**v2.1 Approach**: Only create an entity when:
- ✅ It represents a clear **business domain concept**
- ✅ It's used in **multiple features, pages, or widgets**
- ✅ It has well-defined boundaries and responsibilities

**Don't prematurely extract entities.** If a data structure is only used in one place, keep it there until you need to share it.

### Shared Layer
Reusable infrastructure code with **no business logic**.

```
shared/
  ├── ui/             ← UI kit components
  │   ├── Button/
  │   ├── Input/
  │   └── Modal/
  ├── lib/            ← Utilities
  │   ├── formatDate/
  │   ├── debounce/
  │   └── classnames/
  ├── api/            ← API client setup, base config
  │   ├── client.ts
  │   └── apiRoutes.ts        ← Route constants (v2.1: allowed!)
  ├── config/         ← Environment variables, constants
  │   ├── env.ts
  │   └── appConfig.ts
  ├── assets/         ← Images, fonts, icons
  │   ├── logo.svg            ← Company logo (v2.1: allowed!)
  │   └── icons/
  └── types/          ← Common TypeScript types
```

**v2.1 Update**: Shared can now contain **application-aware** code:
- ✅ Route constants and path builders
- ✅ API endpoint definitions
- ✅ Company branding assets (logos, colors)
- ✅ Application configuration
- ✅ Common type definitions

**Still not allowed**:
- ❌ Business logic (calculations, workflows, domain rules)
- ❌ Feature-specific code
- ❌ Entity-specific code

**No slices in Shared** - organized by segments only. Segments can import from each other within Shared.

## Common Patterns

### 1. Working with API (Pages First Approach)

**Start simple** - keep API logic in the page until you need to reuse it:

```typescript
// pages/profile/api/fetchProfile.ts
export const fetchProfile = (id: string) => 
  apiClient.get(`/users/${id}`);

// pages/profile/model/useProfile.ts
export const useProfile = (id: string) => {
  const [user, setUser] = useState(null);
  
  useEffect(() => {
    fetchProfile(id).then(setUser);
  }, [id]);
  
  return user;
};

// pages/profile/ui/ProfilePage.tsx
import { useProfile } from '../model/useProfile';

const ProfilePage = () => {
  const user = useProfile('123');
  return <div>{user?.name}</div>;
};
```

**Only move to entities when other pages need the same API:**

```typescript
// entities/user/api/userApi.ts
export const fetchUser = (id: string) => 
  apiClient.get(`/users/${id}`);

// entities/user/model/userStore.ts
export const useUser = (id: string) => {
  const [user, setUser] = useState(null);
  
  useEffect(() => {
    fetchUser(id).then(setUser);
  }, [id]);
  
  return user;
};

// entities/user/index.ts
export { useUser } from './model/userStore';
export type { User } from './model/types';

// Now multiple pages can use it:
// pages/profile/ui/ProfilePage.tsx
// pages/user-list/ui/UserListPage.tsx
import { useUser } from '@/entities/user';
```

### 2. Feature Composition

Features can use entities and other features:

```typescript
// features/post-card/ui/PostCard.tsx
import { UserAvatar } from '@/entities/user';
import { LikeButton } from '@/features/like-post';
import { CommentButton } from '@/features/comment-create';

export const PostCard = ({ post }) => (
  <article>
    <UserAvatar userId={post.authorId} />
    <h2>{post.title}</h2>
    <p>{post.content}</p>
    <div>
      <LikeButton postId={post.id} />
      <CommentButton postId={post.id} />
    </div>
  </article>
);
```

### 3. Handling Routes

Routes should be defined in the App layer, pages composed in Pages layer:

```typescript
// app/router.tsx
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { HomePage } from '@/pages/home';
import { ProfilePage } from '@/pages/profile';

const rootRoute = createRootRoute();

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile/$id',
  component: ProfilePage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, profileRoute]),
});

// app/index.tsx
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';

export const App = () => <RouterProvider router={router} />;
```

### 4. Shared UI Components

```typescript
// shared/ui/Button/Button.tsx
export const Button = ({ children, onClick, variant = 'primary' }) => (
  <button className={`btn btn-${variant}`} onClick={onClick}>
    {children}
  </button>
);

// shared/ui/Button/index.ts
export { Button } from './Button';
export type { ButtonProps } from './Button';

// Usage in feature
import { Button } from '@/shared/ui/Button';

const LoginForm = () => (
  <form>
    <Button variant="primary">Login</Button>
  </form>
);
```

## Path Aliases

Use path aliases for clean imports:

```json
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/app/*": ["src/app/*"],
      "@/pages/*": ["src/pages/*"],
      "@/widgets/*": ["src/widgets/*"],
      "@/features/*": ["src/features/*"],
      "@/entities/*": ["src/entities/*"],
      "@/shared/*": ["src/shared/*"]
    }
  }
}
```

## Decision Framework (v2.1 "Pages First")

### When creating new code, follow this decision tree:

1. **Start with: "Where is this code used?"**
   - Used in only one page? → Keep it in that **page/**
   - Used in one widget across multiple pages? → Keep it in that **widget/**
   - Used across multiple pages/widgets? → Continue to question 2

2. **Is it reusable infrastructure?**
   - UI component with no business logic? → **shared/ui/**
   - Utility function (date formatting, etc.)? → **shared/lib/**
   - API client setup, route constants? → **shared/api/** or **shared/config/**
   - If yes to any → **shared/**
   - If no → Continue to question 3

3. **Is it a complete user action?**
   - User interaction (login, add to cart, like post)? → **features/**
   - But only if it's **reused in multiple places**!

4. **Is it a business domain concept?**
   - Core business entity (user, product, order)? → **entities/**
   - But only if it's **reused in multiple places**!

5. **Is it app-wide setup?**
   - Global provider, router, theme? → **app/**

### Quick Decision Examples:

**"User profile form with validation"**
- Used only on profile page? → `pages/profile/ui/ProfileForm.tsx`
- Used on profile + settings pages? → Consider `features/profile-form/`
- Still not sure? → Start in page, extract when you actually need it elsewhere

**"Product card component"**
- Shows on product list page only? → `pages/products/ui/ProductCard.tsx`
- Shows on multiple pages? → `widgets/product-card/` or `entities/product/ui/ProductCard.tsx`
- Generic card layout? → `shared/ui/Card/`

**"Fetch product data"**
- Only product detail page needs it? → `pages/product-detail/api/fetchProduct.ts`
- Multiple pages need it? → `entities/product/api/productApi.ts`

**"Modal manager"**
- Infrastructure for showing modals? → `shared/ui/modal-manager/`
- Content of specific modals? → Keep in pages that use them

### The Golden Rule:

**"When in doubt, keep it in pages/widgets. Extract to lower layers when you actually need to reuse it."**

Don't try to predict reusability. Wait for actual reuse to emerge, then refactor.

## Anti-Patterns to Avoid

❌ **Premature extraction** (v2.1 key anti-pattern)
```typescript
// Immediately creating an entity/feature before knowing if it's needed
// entities/user-profile-form/  ← Used only on one page!
```

✅ **Solution**: Keep in page until actually needed elsewhere
```typescript
// pages/profile/ui/ProfileForm.tsx  ← Start here
// Only move to features/ when another page needs it
```

❌ **Cross-imports between slices on same layer**
```typescript
// features/comments/ui/CommentList.tsx
import { likePost } from '@/features/like-post'; // BAD!
```

✅ **Solution**: Use @x notation for entities, or compose at higher layer
```typescript
// For entities with business relationships:
// entities/user/@x/order.ts
export { UserOrderHistory } from './ui/UserOrderHistory';

// For features, compose at page level:
// pages/post/ui/PostPage.tsx
import { CommentList } from '@/features/comments';
import { LikeButton } from '@/features/like-post';
```

❌ **Business logic in Shared**
```typescript
// shared/lib/userHelpers.ts
export const calculateUserReputation = (user) => { ... }; // BAD!
```

✅ **Solution**: Move to entities layer
```typescript
// entities/user/lib/calculateReputation.ts
export const calculateUserReputation = (user) => { ... };
```

❌ **Bypassing public API**
```typescript
import { LoginButton } from '@/features/auth/ui/LoginButton'; // BAD!
```

✅ **Use public API**
```typescript
import { LoginButton } from '@/features/auth'; // GOOD!
```

❌ **God slices** (too much responsibility)
```typescript
// features/user-management/  ← TOO BROAD
//   - login, register, profile-edit, password-reset, etc.
```

✅ **Split into focused features**
```typescript
// features/auth/
// features/profile-edit/
// features/password-reset/
```

## Migration from FSD v2.0 to v2.1

If you have an existing FSD 2.0 project, migration to 2.1 is **non-breaking**. You can adopt the "pages first" approach gradually.

### Migration Steps:

1. **Audit current features and entities**
   - Which features/entities are used in only one place?
   - Mark them for potential moving to pages/widgets

2. **Move page-specific code back to pages**
   - Forms used on one page → `pages/[page]/ui/`
   - Page-specific API calls → `pages/[page]/api/`
   - Page-specific state → `pages/[page]/model/`

3. **Move widget-specific code to widgets**
   - Logic only used in one widget → keep in that widget
   - Don't extract to features prematurely

4. **Keep truly reusable code in features/entities**
   - Used in 2+ places → stays in features/entities
   - Clear business value → stays in features/entities

5. **Update Shared with application-aware code**
   - Move route constants → `shared/api/routes.ts`
   - Move company assets → `shared/assets/`
   - Keep it free of business logic

6. **Deprecate Processes layer**
   - Move code to features/ with help from app/ if needed

7. **Consider using @x notation**
   - For entities with bidirectional relationships
   - Makes cross-dependencies explicit

### Example Migration:

**Before (v2.0):**
```
features/
  └── user-profile-form/    ← Only used on profile page
      ├── ui/
      ├── model/
      └── api/

pages/
  └── profile/
      └── ui/
          └── ProfilePage.tsx  ← Just composition
```

**After (v2.1):**
```
pages/
  └── profile/
      ├── ui/
      │   ├── ProfilePage.tsx
      │   └── ProfileForm.tsx  ← Moved here
      ├── model/
      │   └── profileStore.ts  ← Moved here
      └── api/
          └── updateProfile.ts ← Moved here
```

## Migration Strategy

When migrating existing code to FSD:

1. **Start with Shared**: Move UI kit, utils, API client to `shared/`
2. **Identify Entities**: Extract business domain models to `entities/`
3. **Extract Features**: Isolate user interactions to `features/`
4. **Create Pages**: Compose pages from widgets and features
5. **Setup App**: Move global providers and routing to `app/`

Do it **gradually** - you don't need to refactor everything at once.

## Working with Different Technologies

### React + Redux
```
features/
  └── todo-list/
      ├── ui/
      │   └── TodoList.tsx
      ├── model/
      │   ├── todoSlice.ts       ← Redux slice
      │   ├── selectors.ts       ← Selectors
      │   └── thunks.ts          ← Async actions
      └── index.ts
```

### React + React Query
```
entities/
  └── user/
      ├── ui/
      ├── api/
      │   └── userQueries.ts     ← React Query hooks
      ├── model/
      │   └── types.ts
      └── index.ts
```

## Framework Integration Examples

### Vite + React + TypeScript
```
project/
  ├── src/
  │   ├── app/
  │   ├── pages/
  │   ├── widgets/
  │   ├── features/
  │   ├── entities/
  │   └── shared/
  ├── tsconfig.json
  ├── vite.config.ts
  └── package.json
```

Vite optimization guidance for FSD projects:

- Keep the FSD tree under `src/` and alias `@` to that directory in both
  `vite.config.ts` and `tsconfig.json`.
- Read browser configuration through `import.meta.env` and `VITE_` variables;
  keep server-only secrets out of `shared/` and client bundles.
- Use route-level `React.lazy` or dynamic `import()` boundaries for heavy
  `pages/`, `widgets/`, maps, editors, charts, and visualization packages.
- Configure `optimizeDeps.include` for large always-used router/query/UI
  dependencies when dev-server startup or first navigation is slow.
- Use `server.warmup.clientFiles` for the app entry, router, and provider stack
  in large projects so Vite transforms the hot path before the first request.
- Prefer `import.meta.glob` for explicit registries when many pages or themes
  are discovered from files; keep generated registries in `app/` or `shared/`
  rather than importing upward from feature layers.

Example Vite config:

```typescript
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  optimizeDeps: {
    include: ["@tanstack/react-router", "@tanstack/react-query"],
  },
  server: {
    warmup: {
      clientFiles: ["./src/main.tsx", "./src/app/router.tsx"],
    },
  },
});
```

### Vite Static SPA
```
project/
  ├── index.html
  ├── vite.config.ts
  └── src/
      ├── app/
      │   ├── main.tsx
      │   └── router/
      ├── pages/
      ├── widgets/
      ├── features/
      ├── entities/
      └── shared/
```

## Key Reminders (v2.1)

1. **Pages First**: Start by keeping code in pages/widgets, extract only when you need to reuse
2. **Wait for actual reuse**: Don't predict reusability, let it emerge naturally
3. **Think in layers**: Determine responsibility level before creating files
4. **Slices are independent**: No imports between slices on the same layer (except @x for entities)
5. **High cohesion**: Keep related code together in slices
6. **Public API is mandatory**: Always define what's exported via index.ts
7. **Business logic can live in pages/widgets**: Don't extract prematurely
8. **Shared is for infrastructure**: Now can include app-aware code (routes, assets) but no business logic
9. **Processes layer deprecated**: Move code to features/ with app/ layer help
10. **Use @x for entity relationships**: Make cross-dependencies explicit and controlled
11. **Segments can import each other**: In App and Shared layers
12. **Follow the import rule**: Only import from layers below

## Quick Reference

**Layer Selection**:
- Global setup → `app/`
- Routes → `pages/`
- Reusable composites → `widgets/`
- User actions → `features/`
- Business models → `entities/`
- Infrastructure → `shared/`

**Import Direction**: App → Pages → Widgets → Features → Entities → Shared

**Public API**: Always create `index.ts` for slices to export public interface

## Additional Resources

For more detailed information and edge cases:
- Cross-imports: When slices need to communicate
- Desegmentation: Why grouping by tech role is anti-pattern
- Routing: Advanced routing patterns
- SSR: Server-side rendering implementation
- Monorepos: Multi-package FSD setup

## Implementation Checklist

When implementing FSD in a project:

- [ ] Setup path aliases in tsconfig.json
- [ ] Create layer folders: app/, pages/, widgets/, features/, entities/, shared/
- [ ] Move UI kit to shared/ui/
- [ ] Move utilities to shared/lib/
- [ ] Start with pages/ - keep code there first
- [ ] Extract to features/entities only when you see actual reuse
- [ ] Setup providers and routing in app/
- [ ] Add public API (index.ts) to each slice
- [ ] Run the bundled checker (`node "<skill-base-dir>/check-fsd.mjs" src`) and drive it to zero errors — see the Enforcement Workflow above
- [ ] Wire the checker into CI (`--strict` fails on unacknowledged REVIEW flags too)
- [ ] Document architecture decisions for team

### Automated enforcement

The primary enforcement tool is this skill's bundled **`check-fsd.mjs`** (see the Enforcement Workflow section at the top): zero-dependency, understands non-standard layouts (`views/`, `entries/`, generated root modules) via built-in defaults plus `fsd.config.json`, separates deterministic ERRORS from judgment-tier REVIEW flags, and supports a documented acknowledge/exception workflow.

[Steiger](https://github.com/feature-sliced/steiger) (`npm install -D @feature-sliced/steiger`, `npx steiger src`) is the official community linter and a fine CI alternative for projects with strictly standard FSD layouts — but it expects canonical layer names and has no review-tier/acknowledgment concept, so prefer the bundled checker when working through this skill.

---

## When to Use This Skill

Trigger this skill when:
- User mentions "FSD", "Feature-Sliced Design", "feature sliced"
- Creating new frontend project structure
- Refactoring existing frontend codebase
- Discussing code organization or architecture
- Questions about where to put specific code
- Issues with cross-imports or dependencies
- Need to decompose features or components
- Setting up project structure for React/Vue/Angular/Svelte
- Migrating from FSD v2.0 to v2.1

**On invocation against an existing FSD codebase, the Enforcement Workflow at the top of this skill is mandatory: run `check-fsd.mjs`, fix every ERROR autonomously, review every REVIEW flag, and re-run until clean.**

## Core Philosophy of FSD v2.1

**"Start simple, extract when needed."**

Don't try to predict the future architecture. Build features in pages and widgets first. When you see actual reuse patterns emerging, then extract to features and entities. This leads to:

- ✅ Better code cohesion (related code stays together)
- ✅ Easier refactoring (everything is in one place)
- ✅ Faster development (no premature abstractions)
- ✅ Clearer architecture (only necessary abstractions exist)
- ✅ Less cognitive overhead (simpler mental model)

This skill provides the foundational knowledge to structure any frontend application using Feature-Sliced Design v2.1 methodology. Always prioritize code cohesion, wait for actual reuse before extracting, and maintain proper layering to ensure maintainable and scalable code architecture.
