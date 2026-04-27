# Dependency Upgrade Plan

## Context

The project has 17 outdated dependencies, ranging from trivial semver-minor bumps to fundamental rewrites (Apollo Server 2 is EOL, TypeScript is 6+ major versions behind). Several dependencies are coupled: Apollo Server 4 requires graphql 16, which requires modern TypeScript; Express 5 requires eliminating the private `_router.stack` hack. Chai 5+ is ESM-only and incompatible with this CommonJS project.

The plan breaks upgrades into 8 phases across ~10 PRs, each independently mergeable.

---

## Phase 0: Safe bumps (1 PR, ~1h)

Bump dependencies with no code changes:

| Package                | From      | To                       |
| ---------------------- | --------- | ------------------------ |
| `winston`              | `^3.13.1` | `^3.19.0`                |
| `dotenv`               | `^16.4.5` | `^16.6.1` (stay on 16.x) |
| `eslint-plugin-import` | `2.29.1`  | `2.32.0`                 |

**Note:** `@aws-sdk/client-s3` was originally planned here but the newer SDK (v3.1033+) uses TypeScript features requiring TS 4+, which breaks with the current TypeScript 3.8. It also requires switching from `S3` to `S3Client` in `src/db.ts:161`. Deferred to Phase 1 (after the TypeScript upgrade).

**Verify:** `npm run build && npm test && npm run lint`

---

## Phase 1: TypeScript 3.8 to 5.8 (1 PR, ~2-4h)

**Package changes:**

- `typescript`: `3.8.3` -> `~5.8.0`
- `@aws-sdk/client-s3`: `^3.926.0` -> `^3.1033.0` (deferred from Phase 0 — requires TS 4+)
- Verify `ts-node` `10.9.2` compatibility (should work)

**Code changes:**

- `src/server.ts`, `src/schema.ts`, `src/metrics.ts`: `import * as express from 'express'` -> `import express = require('express')` — TypeScript 5 correctly enforces that namespace imports are not callable; the `import =` form preserves direct CJS require semantics. Note: `esModuleInterop: true` was considered as an alternative but rejected — it causes `import * as chai from 'chai'` to use a `__importStar` wrapper that breaks chai-http's property injection in tests.
- `src/server.ts:406`: `if (!module.parent)` -> `if (require.main === module)` (`module.parent` deprecated in Node 14+)
- `src/db.ts:5,161`: `S3` -> `S3Client` (newer SDK types only expose `send()` on `S3Client`, not the high-level `S3` wrapper)

**Risks:** Stricter type checking may surface latent errors. `skipLibCheck: true` mitigates third-party type issues. Fix any new type errors that appear.

**Verify:** `npm run build && npm test`

---

## Phase 2: graphql 14 to 15 + remove @types/graphql (1 PR, ~1h)

Intermediate step: graphql 15 is compatible with both apollo-server-express 2 and modern TypeScript. The jump to 16 happens with the Apollo migration (Phase 4).

**Package changes:**

- `graphql`: `^14.7.0` -> `^15.0.0`
- Remove `@types/graphql` from devDependencies (graphql 15 ships own types)
- `@types/express`: `4.16.1` -> `^4.17.21`

**Code changes:** None expected (graphql 15 is backwards-compatible with 14).

**Verify:** `npm run build && npm test`

---

## Phase 3: prom-client 12 to 15 + express-prom-bundle 6 to 8 (1 PR, ~2-3h)

**Package changes:**

- `prom-client`: `^12.0.0` -> `^15.1.0`
- `express-prom-bundle`: `^6.0.0` -> `^8.0.0`

**Code changes:**

- `src/server.ts:378-380`: make `/metrics` handler async — `register.metrics()` returns a Promise in prom-client 13+:
  ```typescript
  // Before:
  app.get('/metrics', (req, res) => {
    res.send(promClient.register.metrics());
  });
  // After:
  app.get('/metrics', async (req, res) => {
    res.send(await promClient.register.metrics());
  });
  ```
- `src/metrics.ts:24`: `collectDefaultMetrics({ prefix: ... })` still works unchanged in prom-client 15 ✓
- No double-registration issues between `metrics.ts` and `express-prom-bundle@8` ✓
- `express-prom-bundle@8` configuration in `src/metrics.ts` required no changes ✓

**Verify:** `npm test` + manual `curl http://localhost:4000/metrics` to confirm valid Prometheus output

---

## Phase 4a: Router stack refactor (1 PR, ~4-6h)

**Prerequisite for both Apollo Server 4 and Express 5.** Eliminate `app._router.stack` manipulation while still on Express 4.

**Problem locations:**

- `src/server.ts:112-116` — splicing router stack to remove expired bundles
- `src/server.ts:393` — reporting stack length in `/cache`
- `src/metrics.ts:54` — gauge for stack length

**Approach:** Replace with a `Map<string, express.Router>` dispatch pattern:

- Store map in app state as `'shaRouters'` (`Map<string, express.Router>`)
- Each Apollo middleware is registered with the full path `/graphqlsha/<sha>` via `getMiddleware()` and stored in the map (no `app.use()` call)
- A single top-level middleware dispatches `/graphqlsha/:sha` requests by SHA lookup, passing `req.url` unchanged (no prefix stripping needed since Apollo is configured with the full path)
- On expiration, `shaRouters.delete(sha)` instead of stack splicing
- `/cache` and metrics report `shaRouters.size` instead of `_router.stack.length`

**Test changes:** `test/multishas/multishas.test.ts` lines 130, 140 reference `_router.stack.length` — replace with `app.get('shaRouters').size`.

**Verify:** `npm test` + manual multi-SHA reload test

---

## Phase 4b: Apollo Server 2 to @apollo/server 4 + graphql 15 to 16 (1-2 PRs, ~8-16h)

The largest and riskiest phase. Depends on Phase 1 (TS 5.x), Phase 2 (graphql 15), Phase 4a (router refactor).

**Package changes:**

- Remove `apollo-server-express`
- Add `@apollo/server` `^4.0.0`
- `graphql`: `^15.0.0` -> `^16.13.0`

**Code changes in `src/schema.ts`:**

- `GraphQLNonNull(t)` -> `new GraphQLNonNull(t)` (graphql 16 requires `new`)
- `GraphQLError` positional args -> options object:
  ```typescript
  throw new GraphQLError(
    `Field "${field}" does not exist on type "${gqlType.name}"`,
    {
      extensions: { code: 'BAD_FILTER_FIELD', gqlType: gqlType.name },
    },
  );
  ```
- `resolveType` must return a type name **string** in graphql 16 — returning a `GraphQLObjectType` object (as v14/v15 allowed) throws at runtime. Return `fieldMap[fieldValue]` and `targetGraphqlType` directly instead of `getObjectType(...)`.
- **`fieldResolver` solution**: Apollo v4 removed the top-level `fieldResolver` option. Wire `defaultResolver(app, bundleSha)` into every field definition without a custom resolver via `if (!fieldDef.resolve) { fieldDef.resolve = defaultResolver(app, bundleSha); }` at the end of `createSchemaType`'s field loop. No `@graphql-tools` needed.

**Code changes in `src/server.ts`:**

- Imports: `apollo-server-express` -> `@apollo/server` + `@apollo/server/express4`
- `buildApolloServer()`: async, `await server.start()`, remove `playground` and `fieldResolver`
- Move `excludeEmptyObjectInArray` and schema extensions into `willSendResponse` plugin using `contextValue.schemas`
- `registerApolloServer()`: `server.getMiddleware()` -> `expressMiddleware(server, { context: async () => ({ schemas: [] }) })`
- Add `express.json()` globally before the dispatcher (required by `expressMiddleware`)
- `csrfPrevention: false` — Apollo v4 adds CSRF protection by default, blocking GET requests without preflight headers. Safe to disable: qontract-server is an internal API with no cookie-based auth.
- Preserve query string when rewriting `/graphql` -> `/graphqlsha/:sha`. Apollo v2 read the GraphQL query from `req.query` (parsed once from the original URL, unaffected by `req.url` rewrites). Apollo v4 reads from `req.url` directly, so stripping the query string broke GET requests.
- Bundle loading loop and `/reload` handler must `await buildApolloServer()`

**Test changes:**

- `extensions: {}` -> `extensions: { schemas: [] }` — Apollo v4 always includes the extensions object; v2 omitted it when empty.

**Verify:** All 9 test files POST to `/graphql` and validate response shapes including `{ data, extensions }`. Full test suite must pass. Manual testing with local bundle recommended.

---

## Phase 5: Express 4 to 5 (1 PR + 1 hotfix, ~3-5h)

Depends on Phase 4a (router refactor — no more `_router.stack`).

**Package changes:**

- `express`: pinned to exact `"5.2.1"` (not `^5.2.1` — avoid surprises from patch releases)
- `@types/express`: pinned to exact `"5.0.6"`

**Code changes:**

- `src/server.ts`: wildcard route syntax — path-to-regexp v8 (bundled with Express 5) uses `{/*rest}` for an **optional** wildcard (zero or more segments). `/*rest` (without braces) is non-optional and causes a 404 when no path follows the filetype:
  ```
  // Before: '/diff/:base_sha/:head_sha/:filetype/*?'
  // After:  '/diff/:base_sha/:head_sha/:filetype{/*rest}'
  ```
- `src/server.ts`: `req.params[0]` -> `req.params.rest`. **Critical:** in Express 5 (path-to-regexp v8), `req.params.rest` for a multi-segment path (e.g. `services/app-interface/app.yml`) is a **`string[]`**, not a `string`. Coercing it naively (template literal or `.toString()`) joins segments with commas, producing an invalid filepath. Must join explicitly:
  ```typescript
  const restParam = req.params.rest as string | string[] | undefined;
  const restPath = Array.isArray(restParam)
    ? restParam.join('/')
    : (restParam ?? '');
  ```
- `src/server.ts`: `@types/express` v5 changes `ParamsDictionary` to `{ [key: string]: string | string[] }`. TypeScript rejects `string | string[]` as an index key. Fix by asserting params type at the top of affected route handlers:
  ```typescript
  const { base_sha: baseSha, head_sha: headSha } = req.params as Record<
    string,
    string
  >;
  ```
  Affected routes: `/diff/:base_sha/:head_sha/:filetype{/*rest}`, `/diff/:base_sha/:head_sha`, `/git-commit/:sha`, `/git-commit-info/:sha`. Use `// eslint-disable-next-line @typescript-eslint/naming-convention` on the destructuring line for the snake_case param names.
- `src/server.ts`: In Express 5, `express.json()` does not set `req.body` for GET requests (leaves it `undefined`). Apollo v4's `expressMiddleware` rejects requests where `req.body` is undefined. Scope a defaulting middleware to GraphQL routes only:
  ```typescript
  app.use(['/graphql', '/graphqlsha'], (req, _res, next) => {
    if (req.body === undefined) {
      Object.assign(req, { body: {} });
    }
    next();
  });
  ```
- Update README.md Limitations section (router stack issue resolved by Phase 4a)

**Post-merge hotfix:** The single-segment test path (`cluster.yml`) masked the `req.params.rest` array bug — `['cluster.yml'].toString()` happens to equal `'cluster.yml'`. Multi-segment paths used in production (e.g. `services/app-interface/app.yml`) hit `404` immediately after Phase 5 merged. Fixed in a follow-up PR with the explicit `Array.isArray` join and a regression test covering multi-segment paths.

**Verify:** `npm test` + manual endpoint testing (including GET GraphQL query and multi-segment `/diff/` path)

---

## Phase 6: ESLint 8 to 9 + switch to typescript-eslint flat config (1 PR, ~3-5h)

Tooling-only, no runtime impact.

**Package changes:**

- `eslint`: `8.57.1` -> `^9.x`
- Replace `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` v5 with `typescript-eslint` ^8.x (unified package with native flat config support)
- Remove `eslint-config-airbnb-base` — has no ESLint 9 flat config support and no ETA (open issue since April 2024); maintainer confirmed it's blocked on all peer deps migrating first
- Keep `eslint-plugin-import` (has native flat config support via `flatConfigs`)

**File changes:**

- Delete `.eslintrc.json`
- Create `eslint.config.js` using `@eslint/js` + `typescript-eslint` recommended configs (no FlatCompat bridge needed):
  - `eslint.configs.recommended` replaces airbnb-base's base ESLint rules
  - `tseslint.configs.recommended` adds TypeScript-specific rules
  - `globals.node` / `globals.mocha` set explicitly via `globals` package — the `env:` shorthand is not available in flat config
  - `sourceType: 'commonjs'` for `.js` files so `require`/`module` globals are recognized
  - `@typescript-eslint/no-require-imports: 'off'` — whole project is CJS
  - `@typescript-eslint/no-explicit-any: 'off'` — widespread existing usage; cleanup is a separate task
  - `caughtErrors: 'none'` on `no-unused-vars` — ESLint 9 changed the default from `'none'` to `'all'`
  - Remove stale `eslint-disable` comments for airbnb-only rules (`no-param-reassign`, `no-restricted-syntax`, etc.)
- `package.json`: `"lint": "eslint . --ext .ts"` -> `"lint": "eslint ."` (`--ext` is ignored in flat config mode)

**Verify:** `npm run lint && npm run build && npm test`

---

## Phase 7: Prettier (1 PR, ~1-2h)

Add Prettier as the code formatter, complementing the ESLint setup. Removing `eslint-config-airbnb-base` in Phase 6 dropped all style enforcement (quotes, semicolons, trailing commas, etc.) — Prettier fills that gap as a dedicated formatter.

**Package changes:**

- Add `prettier`
- Add `eslint-config-prettier` (disables any ESLint rules that conflict with Prettier's output)

**File changes:**

- Create `.prettierrc` with project preferences (e.g. `singleQuote: true`, `trailingComma: 'all'`)
- Update `eslint.config.js`: spread `prettier` config last to disable conflicting rules
- Add `"format": "prettier --write ."` and `"format:check": "prettier --check ."` scripts to `package.json`
- Run `prettier --write .` on the whole codebase — large but purely mechanical diff

**Note:** Keep as a dedicated PR so reviewers can skip the formatting noise. Do not mix with logic changes.

**Verify:** `npm run format:check` passes, `npm run lint && npm test` still pass after formatting

---

## Deferred / Do Not Upgrade

| Package           | Reason                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| **chai 5+/6**     | ESM-only, incompatible with CJS project. Stay on 4.5.0. If needed later, migrate to `node:assert` + `supertest` |
| **@types/chai 5** | Corresponds to Chai 5 ESM. Stay on 4.3.12                                                                       |
| **dotenv 17**     | Changes config loading semantics. Stay on 16.x                                                                  |
| **TypeScript 6**  | Too recent, changes module defaults. Target 5.8                                                                 |
| **ESLint 10**     | Too recent. Target 9.x                                                                                          |

---

## PR Status

| #   | Phase    | Description                                                         | Status           |
| --- | -------- | ------------------------------------------------------------------- | ---------------- |
| 1   | 0        | Safe bumps (winston, dotenv, eslint-plugin-import)                  | ✅ Merged (#277) |
| 2   | 1        | TypeScript 3.8 -> 5.8 + @aws-sdk/client-s3                          | ✅ Merged (#278) |
| 3   | 2        | graphql 14 -> 15, remove @types/graphql, update @types/express      | ✅ Merged (#280) |
| 4   | 3        | prom-client 12 -> 15, express-prom-bundle 6 -> 8                    | ✅ Merged (#281) |
| 5   | 4a       | Router stack refactor (eliminate \_router.stack)                    | ✅ Merged (#282) |
| 6   | 4b       | Apollo Server 2 -> @apollo/server 4, graphql 15 -> 16               | ✅ Merged (#283) |
| 7   | 5        | Express 4 -> 5                                                      | ✅ Merged (#285) |
| 8   | 5 hotfix | Fix multi-segment wildcard array join in /diff route                | ✅ Merged (#287) |
| 9   | 6        | ESLint 8 -> 9, @typescript-eslint v8, flat config, drop airbnb-base | 🔄 Open (#286)   |
| 10  | 7        | Prettier                                                            | 📋 Planned       |
