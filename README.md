# qontract-server

qontract (Queryable cONTRACT) is a collection of tools used to SREs to expose available managed services to application developer teams.
This repository compromises the server component, which is implemented as a GraphQL API.

## Development Environment

Although it is not required, it's recommended that you use [yarn] for install dependencies and running development scripts.

[yarn]: https://yarnpkg.com

To install this projects dependencies to a local `node_modules` directory:

```sh
yarn install
```

To run a process that watches for edits and rebuilds JavaScript:

```sh
yarn run dev
```

To run an instance of the qontract GraphQL console:

```sh
DATAFILES_FILE=your_test_datafile yarn run server
```
