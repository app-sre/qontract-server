const db = require('../models/db');
const base = require('./base');

const typeDefs = `
  type VaultSecret_v1 {
    path: String!
    field: String!
    format: String
  }
`
const resolvers = {}

module.exports = {
    "typeDefs": typeDefs,
    "resolvers": resolvers
};
