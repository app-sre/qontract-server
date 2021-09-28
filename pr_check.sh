#!/bin/bash

npm install tslint
npm install typescript
npm install mocha
npm install yarn

CURRENT_DIR=$(pwd)

$CURRENT_DIR/node_modules/yarn/bin/yarn run lint

$CURRENT_DIR/node_modules/yarn/bin/yarn test
