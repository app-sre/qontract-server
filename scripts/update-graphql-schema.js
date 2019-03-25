#!/usr/bin/env node

/*

Usage:
  update-graphql-schema.js GRAPHQL_SCHEMA_JSON TEST_BUNDLE [TEST_BUNDLE...]

This script will change the `graphql` field of the TEST_BUNDLE with the content
provided in the GRAPHQL_SCHEMA_JSON.

*/

fs = require("fs");

const args = process.argv.slice(2);

const graphql_schema = JSON.parse(fs.readFileSync(args[0]));

args.slice(1).forEach(f => {
  const bundle = JSON.parse(fs.readFileSync(f));
  bundle.graphql = graphql_schema;
  fs.writeFileSync(f, JSON.stringify(bundle, null, 2));
});
