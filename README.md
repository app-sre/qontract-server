# qontract

qontract (Queryable cONTRACT) is a collection of tools used to SREs to expose
available managed services to application developer teams.

## Overview

![qontract overview](images/qontract.png?raw=true "Qontract overview")

This repository comprises the server component, which is a GraphQL API server implemented in Typescript with the [apollo-server-express](https://www.npmjs.com/package/apollo-server-express) package.

The [JSON Schema Validation](https://github.com/app-sre/qontract-validator) lives in a [separate repo](https://github.com/app-sre/qontract-validator).

The Reconcile loop is implementation specific. Any tool that conforms with the following patterns is considered a qontract reconcile tool:

- Retrieves desired state from the GraphQL API.
- Can retrieve the current state by inspecting the service to that needs to be configured.
- Is able to reconcile the service into the desired state from the discovered current state.
- Is idempotent.
- It can run with an option that only simulates what would happen, this called a plan or a dry-run.

An example of an implementation reconcile tools can be obtained from here: [https://github.com/app-sre/qontract-reconcile](qontract-reconcile).

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

Optionally, if you want to specify the path for the app-interface repo on your local filesystem, you can use the parameter:
* `APP_INTERFACE_PATH` - (optional) path to a local app-interface repo (Default: `$PWD/../../service/app-interface`).

Example: To generate the bundle with a specific app-interface path:

```sh
make bundle APP_INTERFACE_PATH=/home/myuser/app-interface/
```

### Running the Qontract GraphQL server

To run an instance of the qontract GraphQL console:

```sh
LOAD_METHOD=fs DATAFILES_FILE=your_test_datafile yarn run server
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
## Style

All code should follow the [airbnb style guide], which is enforced by this
projects lint script:

[airbnb style guide]: https://github.com/airbnb/javascript

```sh
yarn run lint
```
