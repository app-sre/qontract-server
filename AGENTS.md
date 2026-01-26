# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.


## Project Overview

qontract-server is a GraphQL API server that exposes managed services configuration. It's built in TypeScript using apollo-server-express and serves data from bundles (validated JSON files containing datafiles, resourcefiles, and GraphQL schemas).

## Development Commands

### Building and Running
- `npm ci` - use this by default to install dependencies
- `npm install` - Install dependencies and allow changes to be made to package-lock.json
- `npm run build` - Compile TypeScript to JavaScript (output to `dist/`)

### Testing and Linting
- `npm test` - Run mocha test suite (tests in `test/**/*.ts`)
- `npm run lint` - Run ESLint with airbnb-base config
- `npm run lint-fix` - Auto-fix linting issues

### Bundle Management
- `make bundle` - Create/validate bundle using qontract-validator container (requires Docker/Podman)
  - Optionally set `APP_INTERFACE_PATH` and `SCHEMAS_PATH` to use local repos
- `make reload` - Reload bundle into running server via POST to `/reload`
- `make run` - Build bundle and run server locally
- `make dev` - Clean containers, build bundle, run in Docker

## Architecture

### Bundle-Based Data Model

The server operates on **bundles** - immutable snapshots of configuration data identified by SHA256 hashes. Multiple bundle versions can coexist in memory simultaneously, each accessible via `/graphqlsha/<sha>` endpoints.

**Bundle Structure**:
- `datafiles`: Map of JSON schema-validated configuration files (path → Datafile)
- `resourcefiles`: Map of binary/text resources (path → Resourcefile with content and backrefs)
- `datafilesBySchema`: Index grouping datafiles by their `$schema` property
- `schema`: GraphQL schema definition parsed from bundle
- `syntheticBackRefTrie`: Efficient structure for resolving synthetic backreference fields
- `fileHash`: SHA256 identifying this bundle version
- `gitCommit`/`gitCommitTimestamp`: Source repository metadata

### Bundle Lifecycle & Caching

**Initialization**:
- Server can preload multiple bundles via `INIT_BUNDLES` env var (comma-separated `fs://path` or `s3://key` URIs)
- Each bundle gets its own ApolloServer instance mounted at `/graphqlsha/<sha>`
- Latest bundle is aliased to `/graphql`

**Expiration**:
- Bundles have TTL (default 20m via `BUNDLE_SHA_TTL`)
- Querying a bundle refreshes its expiration
- Latest bundle never expires
- Expired bundles removed on `/reload` by splicing Express router stack (unsafe mechanism, see Limitations in README)

**Cache Objects** (stored in Express app state):
- `bundles[sha]`: Bundle instances
- `bundleCache[sha]`: Expiration time + middleware reference
- `objectTypes[sha]`: GraphQL type objects
- `objectInterfaces[sha]`: GraphQL interface types
- `datafileSchemas[sha]`: Mapping of datafile schemas to GraphQL types
- `searchableFields[sha]`: Filter definitions per type

### Dynamic GraphQL Schema Generation

**Schema Building**:
1. Parse bundle's schema definition (array of type configs)
2. Register filter arguments for searchable fields
3. Create GraphQL types (objects and interfaces) for each config
4. Build resolvers for:
   - **Datafile schema fields**: Query datafiles by schema with filtering
   - **Synthetic fields**: Backreferences computed from other datafiles via syntheticBackRefTrie
   - **Resource fields**: Resolve references to resourcefiles
5. Return GraphQLSchema with Query root type

**Reference Resolution**:
- Datafiles can contain `$ref` pointers (e.g., `{$ref: "/path/to/file.yml#/property"}`)
- Default resolver automatically resolves refs when returning field values
- Arrays of refs flattened if schema expects array return type
- Adds referenced datafile's `$schema` to response extensions for tracking

**Interface Resolution** ([schema.ts:560-589](src/schema.ts#L560-L589)):
Two strategies for determining concrete type from interface:
- `fieldMap`: Map specific field value to type name
- `schema`: Use datafile's `$schema` to determine GraphQL type

## Environment Configuration

Create `.env` from `.env.example`:

**Required**:
- `LOAD_METHOD`: `fs` or `s3`
- `DATAFILES_FILE`: Path to bundle.json (if `LOAD_METHOD=fs`)
- `AWS_*`: S3 credentials (if `LOAD_METHOD=s3`)

**Optional**:
- `BUNDLE_SHA_TTL`: Expiration time in ms (default: 1200000 = 20m)
- `INIT_BUNDLES`: Comma-separated bundle URIs for preloading

## Key API Endpoints

- `POST /graphql` - Query latest bundle
- `POST /graphqlsha/:sha` - Query specific bundle version
- `POST /reload` - Load new bundle from data source, expire old bundles
- `GET /sha256` - Get latest bundle SHA
- `GET /diff/:base/:head` - Compare two bundles
- `GET /git-commit-info/:sha` - Get source commit metadata
- `GET /metrics` - Prometheus metrics
- `GET /cache` - Cache state inspection

## Code Style

- Follows airbnb-base ESLint config
- TypeScript with `noImplicitAny` enabled
- Target ES2020, compile to CommonJS
- Mocha tests use ts-node/register for direct `.ts` execution

## Commit Standards

- First, before adding or committing anything, always make sure that Unit and Formatting tests have been run successfully
- Use `Assisted-by:` instead of `Co-Authored-By:`
- Remove whitespace-only lines
- Use double newlines for EOF
