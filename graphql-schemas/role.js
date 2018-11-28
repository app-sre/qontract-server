const db = require('../models/db');
const base = require('./base');
const { JSONPath } = require('jsonpath-plus');
const _ = require('lodash');

const typeDefs = `
  type Role_v1 implements DataFile_v1 {
    schema: String!
    path: String!
    labels: JSON
    name: String!
    members: [Entity_v1]!
    permissions: [Permission_v1]!
  }
`
const resolvers = {
  Role_v1: {
    members(root, args, context, info) {
      // TODO: this is not acceptable, it requires absolute paths
      let jsonpath = `$.roles[?(@["$ref"]=="/${root.path}")]`;
      let users = db.schemaInFilter(["access/user-1.yml", "access/bot-1.yml"]);
      return _.filter(users, user => JSONPath({ json: user, path: jsonpath }).length > 0);
    },
  },
}

module.exports = {
  "typeDefs": typeDefs,
  "resolvers": resolvers
};
