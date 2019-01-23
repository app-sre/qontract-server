const db = require('../models/db');
const base = require('./base');

const typeDefs = `
  type App_v1 implements DataFile_v1 {
    schema: String!
    path: String!
    labels: JSON
    title: String!
    serviceOwner: AppServiceOwner_v1
    performanceParameters: AppPerformanceParameters_v1
    dependencies: [AppDependencies_v1]
    quayRepos: [AppQuayRepos_v1]
  }

  type AppServiceOwner_v1 {
    name: String!
    email: String!
  }

  type AppPerformanceParameters_v1 {
    SLO: Float!
    SLA: Float
    statusPage: String
  }

  type AppDependencies_v1 {
    name: String!
    statefulness: String!
    opsModel: String!
    statusPage: String
    SLA: Float!
    dependencyFailureImpact: String!
  }

  type AppQuayRepos_v1 {
    org: QuayOrg_v1!
    items: [AppQuayReposItems_V1!]!
  }

  type AppQuayReposItems_V1 {
    name: String!
    description: String!
    public: Boolean!
  }
`;

const resolvers = {};

module.exports = {
    "typeDefs": typeDefs,
    "resolvers": resolvers
};
