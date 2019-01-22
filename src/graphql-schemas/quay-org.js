const db = require('../models/db');
const base = require('./base');

const typeDefs = `
  type QuayOrg_v1 implements DataFile_v1 {
    schema: String!
    path: String!
    labels: JSON
    name: String!
    managedTeams: [String!]
    description: String!
    automationToken: VaultSecret_v1
  }
`;
const resolvers = {};

module.exports = {
  "typeDefs": typeDefs,
  "resolvers": resolvers
};
