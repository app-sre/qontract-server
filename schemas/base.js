const db = require('../models/db');
const hash = require('object-hash');
const _ = require('lodash');

var defaultResolver = function (root, args, context, info) {
  let datafileImplementations = info.schema._implementations.DataFile_v1;
  let parentType = info.parentType;

  if (datafileImplementations.includes(parentType)) {
    // TODO: This `if` is a temporary hack. We need to define
    // `context.datafilePath = root.path;` but we must not reassign it every
    // time we shift to another datafile, because it will not revert back to the
    // previous value once we exit a nested field. This means that with the
    // current implementation would be able to resolve one `resolveRef` going to
    // another datafile, but not a second one.
    if (typeof (context.datafilePath) == "undefined") {
      context.datafilePath = root.path;
    }

    if (info.fieldName == "schema") {
      return root["$schema"];
    }
  }

  let val = root[info.fieldName];

  if (val.constructor === Array && val.length > 0) {
    if (!(_.map(val, (e) => db.isRef(e)).includes(false))) {
      let arrayResolve = _.map(val, (e) => db.resolveRef(e, context.datafilePath));
      if (String(info.returnType)[0]=="[") {
        return _.flattenDepth(arrayResolve, 1);
      }
      return arrayResolve;
    }

    return val;
  }

  if (db.isRef(val)) {
    val = db.resolveRef(itemRef, context.datafilePath);
  }

  return val;
}

var typeDefs = `
  scalar JSON

  type Query {
    datafile(label: JSON, schemaIn: [String]): [DataFile_v1]

    # TODO: autogenerate for all types that implement DataFile
    entity(label: JSON): [Entity_v1]
    user(label: JSON): [User_v1]
    bot(label: JSON): [Bot_v1]
    role(label: JSON): [Role_v1]
  }

  interface DataFile_v1 {
    schema: String!
    path: String!
    labels: JSON
  }

  type DataFileGeneric_v1 implements DataFile_v1 {
    schema: String!
    path: String!
    labels: JSON
  }
`

var resolvers = {
  Query: {
    datafile(root, args, context, info) {
      var datafiles = db.datafiles;

      if (args.label) {
        datafiles = db.labelFilter(args.label, datafiles);
      }

      if (args.schemaIn) {
        datafiles = db.schemaInFilter(args.schemaIn, datafiles);
      }

      return datafiles;
    },

    // TODO: autogenerate for all types that implement DataFile
    entity(root, args, context, info) {
      args.schemaIn = ["access/user-1.yml", "access/bot-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    },
    user(root, args, context, info) {
      args.schemaIn = ["access/user-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    },
    bot(root, args, context, info) {
      args.schemaIn = ["access/bot-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    },
    role(root, args, context, info) {
      args.schemaIn = ["access/role-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    }
  },
  DataFile_v1: {
    __resolveType(root, context) {
      // TODO: autogenerate for all types that implement DataFile
      switch (root['$schema']) {
        case "access/user-1.yml":
          return "User_v1";
          break;
        case "access/bot-1.yml":
          return "Bot_v1";
          break;
        case "access/role-1.yml":
          return "Role_v1";
          break;
      }
      return "DataFileGeneric_v1";
    }
  },
}

module.exports = {
  "typeDefs": typeDefs,
  "resolvers": resolvers,
  "defaultResolver": defaultResolver,
};
