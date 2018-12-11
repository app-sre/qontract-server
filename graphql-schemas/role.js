const db = require('../models/db');
const base = require('./base');

const typeDefs = `
  type Role_v1 implements DataFile_v1 {
    schema: String!
    path: String!
    labels: JSON
    name: String!
    members: [Entity_v1]!
    users: [User_v1]!
    bots: [Bot_v1]!
    permissions: [Permission_v1]!
  }
`;

const resolvers = {
  Role_v1: {
    members(root, args, context, info) {
      let schemas = ["access/user-1.yml", "access/bot-1.yml"];
      let subAttr = "roles";

      return db.schemaInFilter(schemas).filter(e =>
        e[subAttr].map(r => db.getRefPath(r.$ref)).includes(root.path)
      );
    },
    users(root, args, context, info) {
      let schemas = ["access/user-1.yml"];
      let subAttr = "roles";

      return db.schemaInFilter(schemas).filter(e =>
        e[subAttr].map(r => db.getRefPath(r.$ref)).includes(root.path)
      );
    },
    bots(root, args, context, info) {
      let schemas = ["access/bot-1.yml"];
      let subAttr = "roles";

      return db.schemaInFilter(schemas).filter(e =>
        e[subAttr].map(r => db.getRefPath(r.$ref)).includes(root.path)
      );
    },
  },
};

module.exports = {
  "typeDefs": typeDefs,
  "resolvers": resolvers
};
