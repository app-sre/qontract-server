const db = require('../models/db');
const base = require('./base');

const typeDefs = `
  interface Permission_v1 {
    service: String!
  }

  type PermissionAWSAnalytics_v1 implements Permission_v1 {
    service: String!
  }

  type PermissionGithubOrg_v1 implements Permission_v1 {
    service: String!
    org: String!
  }

  type PermissionGithubOrgTeam_v1 implements Permission_v1 {
    service: String!
    org: String!
    team: String!
  }

  type PermissionOpenshiftRolebinding_v1 implements Permission_v1 {
    service: String!
    cluster: String!
    namespace: String!
    role: String!
  }

  type PermissionQuayOrgTeam_v1 implements Permission_v1 {
    service: String!
    org: String!
    team: String!
  }
`;

const resolvers = {
    Permission_v1: {
      __resolveType(root, context) {
        switch (root.service) {
          case "aws-analytics": return "PermissionAWSAnalytics_v1";
          case "github-org": return "PermissionGithubOrg_v1";
          case "github-org-team": return "PermissionGithubOrgTeam_v1";
          case "openshift-rolebinding": return "PermissionOpenshiftRolebinding_v1";
          case "quay-membership": return "PermissionQuayOrgTeam_v1";
        }
      }
    }

};

module.exports = {
    "typeDefs": typeDefs,
    "resolvers": resolvers
};
