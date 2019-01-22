const db = require("../models/db");

var defaultResolver = function (root, args, context, info) {
  if (info.fieldName == "schema") {
    return root.$schema;
  }

  let val = root[info.fieldName];

  // if the item is null, return as is
  if (typeof(val) == "undefined") {
    return null;
  }

  if (db.isNonEmptyArray(val)) {
    // are all the elements of this array references?
    checkRefs = val.map(db.isRef);

    // if there are elements that aren't references return the array as is
    if (checkRefs.includes(false)) {
      return val;
    }

    // resolve all the elements of the array
    let arrayResolve = val.map(db.resolveRef);

    // `info.returnType` has information about what the GraphQL schema expects
    // as a return type. If it starts with `[` it means that we need to return
    // an array.
    if (String(info.returnType)[0] == "[") {
      arrayResolve = arrayResolve.flat(1);
    }

    return arrayResolve;
  }

  if (db.isRef(val)) {
    val = db.resolveRef(itemRef);
  }

  return val;
};

// synthetic field. It gets populated by all the users that have a reference
// to this specific role datafile under `.roles[].$ref`.
var syntheticField = function (root, schemas, subAttr) {
  let elements = db.schemaInFilter(schemas);

  return elements.filter(e => {
    if (subAttr in e) {
      let backrefs = e[subAttr].map(r => r.$ref);
      return backrefs.includes(root.path);
    } else {
      return false;
    }
  });
};

var typeDefs = `
  scalar JSON

  type Query {
    datafile(label: JSON, schemaIn: [String]): [DataFile_v1]

    # TODO: autogenerate for all types that implement DataFile
    entity(label: JSON): [Entity_v1]
    user(label: JSON): [User_v1]
    bot(label: JSON): [Bot_v1]
    role(label: JSON): [Role_v1]
    cluster(label: JSON): [Cluster_v1]
    quay_org(label: JSON): [QuayOrg_v1]
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
`;

var resolvers = {
  Query: {
    datafile(root, args, context, info) {
      var datafiles = Object.values(db.datafiles);

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
      args.schemaIn = ["/access/user-1.yml", "/access/bot-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    },
    user(root, args, context, info) {
      args.schemaIn = ["/access/user-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    },
    bot(root, args, context, info) {
      args.schemaIn = ["/access/bot-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    },
    role(root, args, context, info) {
      args.schemaIn = ["/access/role-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    },
    cluster(root, args, context, info) {
      args.schemaIn = ["/openshift/cluster-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    },
    quay_org(root, args, context, info) {
      args.schemaIn = ["/dependencies/quay-org-1.yml"];
      return resolvers.Query.datafile(root, args, context, info);
    },
  },
  DataFile_v1: {
    __resolveType(root, context) {
      // TODO: autogenerate for all types that implement DataFile
      switch (root.$schema) {
        case "/access/user-1.yml": return "User_v1";
        case "/access/bot-1.yml": return "Bot_v1";
        case "/access/role-1.yml": return "Role_v1";
        case "/openshift/cluster-1.yml": return "Cluster_v1";
        case "/dependencies/quay-org-1.yml": return "QuayOrg_v1";
      }
      return "DataFileGeneric_v1";
    }
  },
};

module.exports = {
  "typeDefs": typeDefs,
  "resolvers": resolvers,
  "defaultResolver": defaultResolver,
  "syntheticField": syntheticField,
};
