# qontract

qontract (Queryable cONTRACT) is a collection of tools used to SREs to expose
available managed services to application developer teams.

## Overview

![qontract overview](images/qontract.png?raw=true "Qontract overview")

This repository comprises the server component, which is a GraphQL API server implemented in Typescript with the [apollo-server-express](https://www.npmjs.com/package/apollo-server-express) package.

The [JSON Schema Validation](https://github.com/app-sre/qontract-validator) lives in a [separate repo](https://github.com/app-sre/qontract-validator).

The schemas which are used for validation live in [qontract-schemas](https://github.com/app-sre/qontract-schemas).

The Reconcile loop is implementation specific. Any tool that conforms with the following patterns is considered a qontract reconcile tool:

- Retrieves desired state from the GraphQL API.
- Can retrieve the current state by inspecting the service to that needs to be configured.
- Is able to reconcile the service into the desired state from the discovered current state.
- Is idempotent.
- It can run with an option that only simulates what would happen, this called a plan or a dry-run.

An example of an implementation reconcile tools can be obtained from here: [qontract-reconcile](https://github.com/app-sre/qontract-reconcile).

## Configuration parameters

This server is configured via environment variables.

- `BUNDLE_SHA_TTL`: (not required) Expiration time for bundles. Defaults to `20m`.
- `LOAD_METHOD`: (required) `fs` | `s3`. Source of the data.
- `AWS_ACCESS_KEY_ID`: (required if `LOAD_METHOD=s3`) AWS access key ID.
- `AWS_SECRET_ACCESS_KEY`: (required if `LOAD_METHOD=s3`) AWS secret access key.
- `AWS_REGION`: (required if `LOAD_METHOD=s3`) AWS region.
- `AWS_S3_BUCKET`: (required if `LOAD_METHOD=s3`) AWS s3 bucket name.
- `AWS_S3_KEY`: (required if `LOAD_METHOD=s3`)  AWS s3 key name.

## Bundle Caching

This server is able to store multiple bundle versions. Each time the data is reloaded, the new bundle is exposed on its new `<sha>` on `POST /graphqlsha/<sha>`. Previous shas will continue to work until they have expired.

The shas will expire after a certain amount of time:

- When the data is loaded for the first time, the expiration time is set to 20 minutes in the future (can be overriden by the `BUNDLE_SHA_TTL` environment variable).
- Each time a sha is queried specifically the expiration is refreshed to the `BUNDLE_SHA_TTL` in the future again. This means that shas can be kept available forever by querying them before the `BUNDLE_SHA_TTL` has passed.
- The latest sha, which is the one pointed at by `POST /graphql` will never expire.
- Shas are only expired when `GET /reload` is queried.
- If `GET /reload` is called and there is no new data available, then no shas will be expired.

## API

- `POST /graphqlsha/:sha`: the request body should contain the GraphQL query. The query will be directed at the specified bundle.
- `POST /graphql`: the request body should contain the GraphQL query. The query will be directed at the latest bundle.
- `GET /graphql`: redirects to `POST /graphql`.
- `GET /sha256`: returns the sha of the latest bundle.
- `GET /git-commit-info`: returns json doc with git commit information (commit sha and timestamp)
- `GET /git-commit-info/:sha`: returns json doc with git commit information (commit sha and timestamp) for the specified bundle
- `GET /cache`: returns a json with the cache information.
- `GET /reload`: reloads data from the configured data source.
- `GET /metrics`: prometheus metrics.
- `GET /git-commit`: returns the git commit for the latest bundle. (deprecated, use git-commit-info instead)
- `GET /git-commit/:sha`: returns the git commit for the specified bundle., use git-commit-info instead
- `GET /diff/:sha/:another_sha`: return the difference between two bundles
- `GET /diff/:sha/:another_sha/:filetype/:path`: return the difference for a single `datafile` or `resourcefile`

## Metrics

This server exposes prometheus metrics under `/metrics`.

It includes some custom metrics:

- `qontract_server_reloads_total`: Number of reloads for qontract server.
- `qontract_server_datafiles`: Number of datafiles for a specific schema.
- `qontract_server_router_stack_layers`: Number of layers in the router stack.
- `qontract_server_bundle_object_shas`: Number of shas cached by the application in the bundle object.
- `qontract_server_bundle_cache_object_shas`: Number of shas cached by the application in the bundleCache object.

In addition, it also contains the metrics exposed by the [express prometheus bundle](https://github.com/jochen-schweizer/express-prom-bundle). Note that the `/graphqlsha/<sha>` path has been normalized to avoid cardinality explosion.

## Limitations

- Removing SHAs from the router stack is currently being done using an unsafe mechanism: splicing the private parameter `app._router.stack` which is unsupported and may cause issues. This functionality may break if the Express version is upgraded. However, the testing suite should catch this specific regression. The right solution for this is to replace the entire router, instead of removing the middleware. This has been discussed in this issue: https://github.com/expressjs/express/issues/4436.

## Development Environment

### Setting up yarn

Although it is not required, it's recommended that you use [yarn] for install
dependencies and running development scripts.

[yarn]: https://yarnpkg.com

To install this projects dependencies to a local `node_modules` directory:

```sh
yarn install
```

To run a process that watches for edits and rebuilds JavaScript from TypeScript:

```sh
yarn run watch
```

Or alternatively, you can run the TypeScript compilation once:

```sh
yarn build
```
### Creating and validating the bundle

The data files bundle is required to start the server. Once you're in the `qontract-server` directory, run:

```sh
make bundle
```
Note that this requires Docker to be running on the host.

Optionally, if you want to specify the path for the app-interface repo or qontract-schemas repo on your local filesystem, you can use the parameter:
* `APP_INTERFACE_PATH` - (optional) path to a local app-interface repo (Default: `$PWD/../../service/app-interface`).
* `SCHEMAS_PATH` - (optional) path to a local qontract-schemas repo (Default: `$PWD/../qontract-schemas`)

Example: To generate the bundle with a specific app-interface path:

```sh
make bundle APP_INTERFACE_PATH=/home/myuser/app-interface/
```

### Running the Qontract GraphQL server

Create `.env` file from example:

```shell
cp .env.example .env
```

Customize the `.env` file as needed, for example:

```
LOAD_METHOD=fs
DATAFILES_FILE=./bundle/bundle.json
```

To run an instance of the qontract GraphQL console:

```sh
yarn run server
```

Specific instructions for CentOS 7:

```sh
# Install node10
sudo yum install centos-release-scl-rh
sudo yum install rh-nodejs10

# Install yarn (as root)
scl enable rh-nodejs10 bash
npm install -g yarn

# Enable node10 (as user in qontract-server git repo)
scl enable rh-nodejs10 bash

# Install qontract-server yarn modules
yarn install

# Build the JavaScript
yarn build

# Start the server
make run
```

### Preload bundles

Especially during PR checks, a `qontract-server` with multiple bundles preloaded simplifies test infra setup. For this the env variable `INIT_BUNDLE` to specify a comma separated list of bundle references of the following form

- fs://path/to/bundle
- s3://bundle-key

The s3 flavour relies on the `AWS_*` env variables to specify the bucket and configure authentication. the specified `bundle-key` is used as `AWS_S3_KEY`.

The bundles listed in `INIT_BUNDLE` are added to the `qontract-server` in the order they are specified. This means that the bundle listed last is also the one returned by the `/sha256` endpoint.

## Style

All code should follow the [airbnb style guide], which is enforced by this
projects lint script:

[airbnb style guide]: https://github.com/airbnb/javascript

```sh
yarn run lint
```

## GQL query filtering

While GQL does not define how filtering should work, it provides room for arguments to passed into queries. `qontract-server` offers a generic `filter` argument, that can be used to filter the resultset of a query.

```gql
query MyQuery($filter: JSON) {
    clusters: clusters_v1(filter: $filter) {
        ...
    }
}
```

The filter argument is a JSON document that can have the following content.

### Field equality predicate

To filter on an fields value, use the following filter object syntax

```json
"filter": {
    "my_field": "my_value"
}
```

This way only resources with such a field and value are returned by the query.

Also works for null.

```json
"filter": {
    "my_field": null
}
```

### Field not-equal predicate

To check if a property value is not equal to a certain value, use the `ne` filter predicate

```json
"filter": {
    "my_field": {
        "ne": "my_value"
    }
}
```

This also works to check for missing values or references.

```json
"filter": {
    "my_field": {
        "ne": null
    }
}
```

### List contains predicate

Field values can be also compared towards a list of acceptable values.

```json
"filter": {
    "my_field": {
        "in": ["a", "b", "c"]
    }
}
```

This way only resources are returned where the respective field is a or b or c.

### Nested predicates

Filtering is also supported on nested structures of a resource.

```json
"filter": {
    "nested_resources": {
        "filter": {
            "nested_field": "nested_value"
        }
    }
}
```

Note this feature currently only support non array fields,
the behaviour of filter list fields is undefined.
