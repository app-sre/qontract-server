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
    // synthetic field. It gets populated by all the users and bots that have a
    // reference to this specific role datafile under `.roles[].$ref`.
    members(root, args, context, info) {
      let schemas = ["access/user-1.yml", "access/bot-1.yml"];
      let subAttr = "roles";

      let members = db.schemaInFilter(schemas);

      return members.filter(e => {
        let backrefs = e[subAttr].map(r => db.getRefPath(r.$ref));
        return backrefs.includes(root.path);
      });
    },
    // synthetic field. It gets populated by all the users that have a reference
    // to this specific role datafile under `.roles[].$ref`.
    users(root, args, context, info) {
      let schemas = ["access/user-1.yml"];
      let subAttr = "roles";

      let users = db.schemaInFilter(schemas);

      return users.filter(e => {
        let backrefs = e[subAttr].map(r => db.getRefPath(r.$ref));
        return backrefs.includes(root.path);
      });
    },
    // synthetic field. It gets populated by all the bots that have a reference
    // to this specific role datafile under `.roles[].$ref`.
    bots(root, args, context, info) {
      let schemas = ["access/bot-1.yml"];
      let subAttr = "roles";

      let bots = db.schemaInFilter(schemas)

      return bots.filter(e => {
        let backrefs = e[subAttr].map(r => db.getRefPath(r.$ref));
        return backrefs.includes(root.path);
      });
    },
  },
};

module.exports = {
  "typeDefs": typeDefs,
  "resolvers": resolvers
};
