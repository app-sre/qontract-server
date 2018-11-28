const db = require('../models/db');
const base = require('./base');

const typeDefs = `
  type Bot_v1 implements DataFile_v1 {
    schema: String!
    path: String!
    labels: JSON
    name: String!
    github_username: String
    owner: User_v1
  }
`
const resolvers = {}

module.exports = {
  "typeDefs": typeDefs,
  "resolvers": resolvers
};
