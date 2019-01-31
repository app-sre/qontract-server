import * as db from './db';

import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLList,
  GraphQLNonNull,
  GraphQLInterfaceType,
} from 'graphql';

const isRef = function (obj: any) {
  if (obj.constructor === Object) {
    if (Object.keys(obj).length === 1 && ('$ref' in obj)) {
      return true;
    }
  }
  return false;
};

const isNonEmptyArray = function (obj: any) {
  return obj.constructor === Array && obj.length > 0;
};

// ------------------ START SCHEMA ------------------

// COMMON FIELDS

const jsonType = new GraphQLScalarType({
  name: 'JSON',
  serialize: JSON.stringify,
});

const schemaTypes = [];

// PERMISSION

const permissionResolveType = ({ service }: any): GraphQLObjectType => {
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

// USER -- datafile

const schemaTypesHelper: any = {};

const buildSchemaObject = (config: any) => {
  const userFields: any = config.fields.reduce(
    (userFields: any, fieldInfo: any) => {
      let t = fieldInfo.type;
      if ('required' in config && config.required) {
        t = new GraphQLNonNull(t);
      }
      userFields[fieldInfo.name] = { type: t };
      return userFields;
    },
    {},
  );

  schemaTypesHelper[config.name] = new GraphQLObjectType({
    name: `${config.name}_v${config.version}`,
    fields: userFields,
  });

  const objectSchema: any = {
    type: new GraphQLList(schemaTypesHelper[config.name]),
  };

  if ('datafile' in config) {
    objectSchema['resolve'] = () => db.getDatafilesBySchema(config.datafile);
  }

  return objectSchema;
};

appSchemaFields['user'] = buildSchemaObject({
  name: 'User',
  version: '1',
  datafile: '/access/user-1.yml',

  fields: [
    { name: 'schema', type: GraphQLString, required: true },
    { name: 'labels', type: jsonType, required: true },
    { name: 'name', type: GraphQLString, required: true },
    { name: 'redhat_username', type: GraphQLString, required: true },
    { name: 'github_username', type: GraphQLString, required: true },
    { name: 'quay_username', type: GraphQLString, required: false },
  ],
});

appSchemaFields['bot'] = buildSchemaObject({
  name: 'Bot',
  version: '1',
  datafile: '/access/bot-1.yml',

  fields: [
    { name: 'schema', type: GraphQLString, required: true },
    { name: 'path', type: GraphQLString, required: true },
    { name: 'labels', type: jsonType, required: true },
    { name: 'name', type: GraphQLString, required: true },
    { name: 'github_username', type: GraphQLString, required: false },
    { name: 'quay_username', type: GraphQLString, required: false },
    { name: 'owner', type: schemaTypesHelper['User'], required: false },
  ],
});

// ROLE - datafile

const roleFields: any = {};
roleFields['schema'] = { type: new GraphQLNonNull(GraphQLString) };
roleFields['path'] = { type: new GraphQLNonNull(GraphQLString) };
roleFields['labels'] = { type: jsonType };
roleFields['name'] = { type: new GraphQLNonNull(GraphQLString) };
roleFields['permissions'] = { type: new GraphQLList(permissionInterface) };
roleFields['users'] = {
  type: new GraphQLList(schemaTypesHelper['User']),
  resolve: (root: any) => {
    const schema = '/access/user-1.yml';
    const subAttr = 'roles';
    return resolveSyntheticField(root, schema, subAttr);
  },
};
roleFields['bots'] = {
  type: new GraphQLList(schemaTypesHelper['User']),
  resolve: (root: any) => {
    const schema = '/access/bot-1.yml';
    const subAttr = 'roles';
    return resolveSyntheticField(root, schema, subAttr);
  },
};

const roleType = new GraphQLObjectType({
  name: 'Role_v1',
  fields: roleFields,
});

appSchemaFields['role'] = {
  type: new GraphQLList(roleType),
  resolve: () => db.getDatafilesBySchema('/access/role-1.yml'),
};

// BUILD SCHEMA

// synthetic field. It gets populated by all the users that have a reference
// to this specific role datafile under `.roles[].$ref`.
function resolveSyntheticField(root: any, schema: string, subAttr: string) {
  const elements = db.getDatafilesBySchema(schema);

  return elements.filter((e: any) => {
    if (subAttr in e) {
      const backrefs = e[subAttr].map((r: any) => r.$ref);
      return backrefs.includes(root.path);
    }
    return false;
  });
}

export function defaultResolver(root: any, args: any, context: any, info: any) {
  if (info.fieldName === 'schema') {
    return root.$schema;
  }

  let val = root[info.fieldName];

  // if the item is null, return as is
  if (typeof (val) === 'undefined') {
    return null;
  }

  if (isNonEmptyArray(val)) {
    // are all the elements of this array references?
    const checkRefs = val.map(isRef);

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

  if (isRef(val)) {
    val = db.resolveRef(val);
  }

  return val;
}

export const appSchema = new GraphQLSchema({
  types: schemaTypes,
  query: new GraphQLObjectType({
    name: 'Query',
    fields: appSchemaFields,
  }),
});
