const db = require('../models/db');
const base = require('./base');

const typeDefs = `
  type User_v1 implements DataFile_v1 {
    schema: String!
    path: String!
    labels: JSON
    name: String!
    redhat_username: String!
    github_username: String!
  }
`
const resolvers = {}

module.exports = {
  "typeDefs": typeDefs,
  "resolvers": resolvers
};
