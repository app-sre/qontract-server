const db = require('../models/db');
const base = require('./base');

const typeDefs = `
  type ClusterManagedRole_v1 {
    namespace: String!
    role: String!
  }

  type Cluster_v1 implements DataFile_v1 {
    schema: String!
    path: String!
    labels: JSON
    name: String!
    description: String!
    serverUrl: String!
    automationToken: VaultSecret_v1
    managedRoles: [ClusterManagedRole_v1]
  }
`;
const resolvers = {};

module.exports = {
  "typeDefs": typeDefs,
  "resolvers": resolvers
};
