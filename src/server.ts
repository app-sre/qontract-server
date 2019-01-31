require('dotenv').config();

import { ApolloServer, gql } from 'apollo-server-express';
import * as express from 'express';
import { makeExecutableSchema } from 'graphql-tools';

import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLList,
  GraphQLNonNull,
  GraphQLInterfaceType,
  printSchema,
} from 'graphql';

const db = require('./models/db');
const base = require('./graphql-schemas/base');

db.load();

// https://graphql.org/graphql-js/constructing-types/

const filterBySchema = function (schema: string) {
  return Object.values(db.datafiles).filter((d: any) => d.$schema === schema);
};

const defaultResolver = (root: any, args: any, context: any, info: any) => {
  if (info.fieldName === 'schema') {
    return root.$schema;
  }

  let val = root[info.fieldName];

  // if the item is null, return as is
  if (typeof (val) === 'undefined') {
    return null;
  }

  if (db.isNonEmptyArray(val)) {
    // are all the elements of this array references?
    const checkRefs = val.map(db.isRef);

    // if there are elements that aren't references return the array as is
    if (checkRefs.includes(false)) {
      return val;
    }

    // resolve all the elements of the array
    let arrayResolve = val.map(db.resolveRef);

    // `info.returnType` has information about what the GraphQL schema expects
    // as a return type. If it starts with `[` it means that we need to return
    // an array.
    if (String(info.returnType)[0] === '[') {
      arrayResolve = arrayResolve.flat(1);
    }

    return arrayResolve;
  }

  if (db.isRef(val)) {
    val = db.resolveRef(val);
  }

  return val;
};

// ------------------ START SCHEMA ------------------

// COMMON FIELDS

const jsonType = new GraphQLScalarType({
  name: 'JSON',
  serialize: JSON.stringify,
});

const schemaTypes = [];

// PERMISSION

const permissionResolveType = ({ service }: any) : GraphQLObjectType => {
  switch (service) {
    case 'aws-analytics': return permissionAWSAnalyticsType;
    case 'github-org': return permissionGithubOrgType;
    case 'github-org-team': return permissionGithubOrgTeamType;
    case 'openshift-rolebinding': return permissionOpenshiftRolebindingType;
    case 'quay-membership': return permissionQuayOrgTeamType;
  }
};

// -

const permissionFields: any = {};
permissionFields['service'] = { type: new GraphQLNonNull(GraphQLString) };

const permissionInterface: GraphQLInterfaceType = new GraphQLInterfaceType({
  name: 'Permission_v1',
  fields: permissionFields,
  resolveType: permissionResolveType,
});

// -

const permissionAWSAnalyticsFields: any = {};
permissionAWSAnalyticsFields['service'] = { type: new GraphQLNonNull(GraphQLString) };

const permissionAWSAnalyticsType = new GraphQLObjectType({
  name: 'PermissionAWSAnalytics_v1',
  interfaces: [permissionInterface],
  fields: permissionAWSAnalyticsFields,
});

schemaTypes.push(permissionAWSAnalyticsType);
// -

const permissionGithubOrgFields: any = {};
permissionGithubOrgFields['service'] = { type: new GraphQLNonNull(GraphQLString) };
permissionGithubOrgFields['org'] = { type: new GraphQLNonNull(GraphQLString) };

const permissionGithubOrgType = new GraphQLObjectType({
  name: 'PermissionGithubOrg_v1',
  interfaces: [permissionInterface],
  fields: permissionGithubOrgFields,
});

schemaTypes.push(permissionGithubOrgType);

// -

const permissionGithubOrgTeamFields: any = {};
permissionGithubOrgTeamFields['service'] = { type: new GraphQLNonNull(GraphQLString) };
permissionGithubOrgTeamFields['org'] = { type: new GraphQLNonNull(GraphQLString) };
permissionGithubOrgTeamFields['team'] = { type: new GraphQLNonNull(GraphQLString) };

const permissionGithubOrgTeamType = new GraphQLObjectType({
  name: 'PermissionGithubOrgTeam_v1',
  interfaces: [permissionInterface],
  fields: permissionGithubOrgTeamFields,
});

schemaTypes.push(permissionGithubOrgTeamType);

// -

const permissionOpenshiftRolebindingFields: any = {};
permissionOpenshiftRolebindingFields['service'] = { type: new GraphQLNonNull(GraphQLString) };
permissionOpenshiftRolebindingFields['cluster'] = { type: new GraphQLNonNull(GraphQLString) };
permissionOpenshiftRolebindingFields['namespace'] = { type: new GraphQLNonNull(GraphQLString) };
permissionOpenshiftRolebindingFields['role'] = { type: new GraphQLNonNull(GraphQLString) };

const permissionOpenshiftRolebindingType = new GraphQLObjectType({
  name: 'PermissionOpenshiftRolebinding_v1',
  interfaces: [permissionInterface],
  fields: permissionOpenshiftRolebindingFields,
});

schemaTypes.push(permissionOpenshiftRolebindingType);

// -

const permissionQuayOrgTeamFields: any = {};
permissionQuayOrgTeamFields['service'] = { type: new GraphQLNonNull(GraphQLString) };
permissionQuayOrgTeamFields['org'] = { type: new GraphQLNonNull(GraphQLString) };
permissionQuayOrgTeamFields['team'] = { type: new GraphQLNonNull(GraphQLString) };

const permissionQuayOrgTeamType = new GraphQLObjectType({
  name: 'PermissionQuayOrgTeam_v1',
  interfaces: [permissionInterface],
  fields: permissionQuayOrgTeamFields,
});

schemaTypes.push(permissionQuayOrgTeamType);

// ------- DATAFILES -------

const appSchemaFields: any = {};

// ROLE - datafile

const roleFields: any = {};
roleFields['schema'] = { type: new GraphQLNonNull(GraphQLString) };
roleFields['path'] = { type: new GraphQLNonNull(GraphQLString) };
roleFields['labels'] = { type: jsonType };
roleFields['name'] = { type: new GraphQLNonNull(GraphQLString) };
roleFields['permissions'] = { type: new GraphQLList(permissionInterface) };

const roleType = new GraphQLObjectType({
  name: 'Role_v1',
  fields: roleFields,
});

appSchemaFields['role'] = {
  type: new GraphQLList(roleType),
  args: {
    label: { type: jsonType },
  },
  resolve: () => filterBySchema('/access/role-1.yml'),
};

// USER - datafile

const userFields: any = {};
userFields['schema'] = { type: new GraphQLNonNull(GraphQLString) };
userFields['path'] = { type: new GraphQLNonNull(GraphQLString) };
userFields['labels'] = { type: jsonType };
userFields['name'] = { type: new GraphQLNonNull(GraphQLString) };
userFields['redhat_username'] = { type: new GraphQLNonNull(GraphQLString) };
userFields['github_username'] = { type: new GraphQLNonNull(GraphQLString) };
userFields['quay_username'] = { type: GraphQLString };

const userType = new GraphQLObjectType({
  name: 'User_v1',
  fields: userFields,
});

appSchemaFields['user'] = {
  type: new GraphQLList(userType),
  args: {
    label: { type: jsonType },
  },
  resolve: () => filterBySchema('/access/user-1.yml'),
};

// BOT

const botFields: any = {};
botFields['schema'] = { type: new GraphQLNonNull(GraphQLString) };
botFields['path'] = { type: new GraphQLNonNull(GraphQLString) };
botFields['labels'] = { type: jsonType };
botFields['name'] = { type: new GraphQLNonNull(GraphQLString) };
botFields['github_username'] = { type: GraphQLString };
botFields['quay_username'] = { type: GraphQLString };
botFields['owner'] = { type: userType };

const botType = new GraphQLObjectType({
  name: 'Bot_v1',
  fields: botFields,
});

appSchemaFields['bot'] = {
  type: new GraphQLList(botType),
  args: {
    label: { type: jsonType },
  },
  resolve: () => filterBySchema('/access/bot-1.yml'),
};

// BUILD SCHEMA

const appSchema = new GraphQLSchema({
  types: schemaTypes,
  query: new GraphQLObjectType({
    name: 'Query',
    fields: appSchemaFields,
  }),
});

// ------------------ END SCHEMA ------------------

const app = express();
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if ((!['/', '/reload'].includes(req.url)) && (db.datafiles.length === 0 || db.sha256 === '')) {
    res.status(503).send('No loaded data.');
    return;
  }
  next();
});

const server = new ApolloServer({
  schema: appSchema,
  playground: true,
  introspection: true,
  fieldResolver: defaultResolver,
});
server.applyMiddleware({ app });

app.get('/reload', (req: express.Request, res: express.Response) => { db.load(); res.send(); });
app.get('/sha256', (req: express.Request, res: express.Response) => { res.send(db.sha256); });
app.get('/healthz', (req: express.Request, res: express.Response) => { res.send(); });
app.get('/', (req: express.Request, res: express.Response) => { res.redirect('/graphql'); });

module.exports = app.listen({ port: 4000 }, () => {
  console.log(`Running at http://localhost:4000${server.graphqlPath}`);
});
