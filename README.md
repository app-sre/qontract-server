# qontract-server

qontract (Queryable cONTRACT) is a collection of tools used to SREs to expose
available managed services to application developer teams. This repository
compromises the server component, which is implemented as a GraphQL API.

## Development Environment

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
## Creating and validating the bundle

The bundle is required to start the server.

```sh
make bundle
```

* `APP_INTERFACE_PATH` - (optional) path to a local app-interface repo (Default: `$PWD/../../service/app-interface`).

## Style

All code should follow the [airbnb style guide], which is enforced by this
projects lint script:

[airbnb style guide]: https://github.com/airbnb/javascript

```sh
yarn run lint
```

