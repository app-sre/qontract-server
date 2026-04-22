# Dependency Upgrade Plan

## Context

The project has 17 outdated dependencies, ranging from trivial semver-minor bumps to fundamental rewrites (Apollo Server 2 is EOL, TypeScript is 6+ major versions behind). Several dependencies are coupled: Apollo Server 4 requires graphql 16, which requires modern TypeScript; Express 5 requires eliminating the private `_router.stack` hack. Chai 5+ is ESM-only and incompatible with this CommonJS project.

The plan breaks upgrades into 7 phases across ~8 PRs, each independently mergeable.

---

## Phase 0: Safe bumps (1 PR, ~1h)

Bump dependencies with no code changes:

| Package | From | To |
|---|---|---|
| `winston` | `^3.13.1` | `^3.19.0` |
| `dotenv` | `^16.4.5` | `^16.6.1` (stay on 16.x) |
| `eslint-plugin-import` | `2.29.1` | `2.32.0` |

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
  app.get('/metrics', (req, res) => { res.send(promClient.register.metrics()); });
  // After:
  app.get('/metrics', async (req, res) => { res.send(await promClient.register.metrics()); });
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
- Line 456: `GraphQLNonNull(t)` -> `new GraphQLNonNull(t)`
- Lines 257-268: `GraphQLError` positional args -> options object:
  ```typescript
  throw new GraphQLError(`Field "${field}" does not exist on type "${gqlType.name}"`, {
    extensions: { code: 'BAD_FILTER_FIELD', gqlType: gqlType.name },
  });
  ```

**Code changes in `src/server.ts`:**
- Line 2: `import { ApolloServer } from 'apollo-server-express'` -> `import { ApolloServer } from '@apollo/server'` + `import { expressMiddleware } from '@apollo/server/express4'`
- `buildApolloServer()` (lines 68-91): must become async, call `await server.start()`
  - Remove `playground: true` (Apollo Sandbox replaces it)
  - Remove `formatResponse` — move `excludeEmptyObjectInArray` into `willSendResponse` plugin
  - `fieldResolver` is not a top-level option in v4 — integrate into schema construction or use schema transform
  - Plugin signature: `requestDidStart` returns async, `willSendResponse` receives single context object, `requestContext.context` -> `requestContext.contextValue`
- `registerApolloServer()` (lines 22-38): `server.getMiddleware()` -> `expressMiddleware(server, { context: async () => ({ schemas: [] }) })`; must add `express.json()` middleware before it
- Lines 180-188: bundle loading loop must `await buildApolloServer()`
- Lines 190-222: `/reload` handler must `await buildApolloServer()`

**Key risk: `fieldResolver` removal.** The current `defaultResolver` (`src/schema.ts:387-406`) handles $ref resolution, schema tracking, and filtering. In Apollo 4 this needs to be wired directly into schema field definitions during construction, or via `@graphql-tools/utils` `mapSchema`.

**Verify:** All 9 test files POST to `/graphql` and validate response shapes including `{ data, extensions }`. Full test suite must pass. Manual testing with local bundle recommended.

---

## Phase 5: Express 4 to 5 (1 PR, ~3-5h)

Depends on Phase 4a (router refactor — no more `_router.stack`).

**Package changes:**
- `express`: `^4.17.1` -> `^5.2.0`
- `@types/express`: `^4.17.21` -> `^5.0.0`

**Code changes:**
- `src/server.ts:231`: wildcard route syntax change:
  ```
  // Before: '/diff/:base_sha/:head_sha/:filetype/*?'
  // After:  '/diff/:base_sha/:head_sha/:filetype/*rest'
  ```
- `src/server.ts:244`: `req.params[0]` -> `req.params.rest`
- Update README.md Limitations section (router stack issue resolved by Phase 4a)

**Verify:** `npm test` + manual endpoint testing

---

## Phase 6: ESLint 8 to 9 + @typescript-eslint v8 (1 PR, ~3-5h)

Tooling-only, no runtime impact.

**Package changes:**
- `eslint`: `8.57.1` -> `^9.0.0`
- `@typescript-eslint/eslint-plugin`: `5.60.1` -> `^8.0.0`
- `@typescript-eslint/parser`: `5.60.1` -> `^8.0.0`
- Evaluate `eslint-config-airbnb-base` flat config support; may need `@eslint/eslintrc` `FlatCompat` bridge

**File changes:**
- Delete `.eslintrc.json`
- Create `eslint.config.js` with flat config format
- `package.json`: `"lint": "eslint . --ext .ts"` -> `"lint": "eslint ."`

**Verify:** `npm run lint` produces same or comparable results

---

## Deferred / Do Not Upgrade

| Package | Reason |
|---|---|
| **chai 5+/6** | ESM-only, incompatible with CJS project. Stay on 4.5.0. If needed later, migrate to `node:assert` + `supertest` |
| **@types/chai 5** | Corresponds to Chai 5 ESM. Stay on 4.3.12 |
| **dotenv 17** | Changes config loading semantics. Stay on 16.x |
| **TypeScript 6** | Too recent, changes module defaults. Target 5.8 |
| **ESLint 10** | Too recent. Target 9.x |

---

## Suggested PR Order

| # | Phase | Description | Risk | Effort |
|---|---|---|---|---|
| 1 | 0 | Safe bumps (winston, dotenv, eslint-plugin-import) | LOW | ~1h |
| 2 | 1 | TypeScript 3.8 -> 5.8 + @aws-sdk/client-s3 | MODERATE | ~2-4h |
| 3 | 2 | graphql 14 -> 15, remove @types/graphql, update @types/express | LOW | ~1h |
| 4 | 3 | prom-client 12 -> 15, express-prom-bundle 6 -> 8 | LOW-MOD | ~2-3h |
| 5 | 4a | Router stack refactor (eliminate _router.stack) | MODERATE | ~4-6h |
| 6 | 4b | Apollo Server 2 -> @apollo/server 4, graphql 15 -> 16 | HIGH | ~8-16h |
| 7 | 5 | Express 4 -> 5 | MODERATE | ~3-5h |
| 8 | 6 | ESLint 8 -> 9, @typescript-eslint v8, flat config | MODERATE | ~3-5h |

**Total estimated effort: ~24-40h**
