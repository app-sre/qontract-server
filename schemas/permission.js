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
    permission: String!
  }

  type PermissionQuayOrg_v1 implements Permission_v1 {
    service: String!
    org: String!
  }
`
const resolvers = {
    Permission_v1: {
      __resolveType(root, context) {
        switch (root['service']) {
          case "aws-analytics":
            return "PermissionAWSAnalytics_v1";
            break;
          case "github-org":
            return "PermissionGithubOrg_v1";
            break;
          case "github-org-team":
            return "PermissionGithubOrgTeam_v1";
            break;
          case "openshift-rolebinding":
            return "PermissionOpenshiftRolebinding_v1";
            break;
          case "quay-org":
            return "PermissionQuayOrg_v1";
            break;
        }
      }
    }

}

module.exports = {
    "typeDefs": typeDefs,
    "resolvers": resolvers
};
