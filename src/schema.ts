import * as db from './db';

import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLList,
  GraphQLNonNull,
  GraphQLInterfaceType,
  astFromValue,
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

const resolveSyntheticField = function (root: any, schema: string, subAttr: string) {
  const elements = db.getDatafilesBySchema(schema);

  return elements.filter((e: any) => {
    if (subAttr in e) {
      const backrefs = e[subAttr].map((r: any) => r.$ref);
      return backrefs.includes(root.path);
    }
    return false;
  });
};

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
// ------------------ START SCHEMA ------------------

const createSchemaType = (schemaTypes: any, interfaceTypes: any, conf: any) => {
  const objTypeConf: any = {};

  // name
  if (conf.version) {
    objTypeConf['name'] = `${conf.name}_v${conf.version}`;
  } else {
    objTypeConf['name'] = conf.name;
  }

  // fields
  objTypeConf['fields'] = conf.fields.reduce(
    (objFields: any, fieldInfo: any) => {
      const fieldDef: any = {};

      // type
      let t = fieldInfo.type;

      if (typeof t === 'string') {
        t = schemaTypes[t];
      }

      if (fieldInfo.isRequired) {
        t = new GraphQLNonNull(t);
      }

      if (fieldInfo.isList) {
        t = new GraphQLList(t);
      }

      fieldDef['type'] = t;

      // schema
      if (fieldInfo.datafileSchema) {
        fieldDef['resolve'] = () => db.getDatafilesBySchema(fieldInfo.datafileSchema);
      }

      // synthetic
      if (fieldInfo.synthetic) {
        fieldDef['resolve'] = (root: any) => resolveSyntheticField(
          root,
          fieldInfo.synthetic.schema,
          fieldInfo.synthetic.subAttr,
        );
      }

      // return
      objFields[fieldInfo.name] = fieldDef;
      return objFields;
    },
    {},
  );

  // interfaces
  if (conf.interface) {
    objTypeConf['interfaces'] = [interfaceTypes[conf.interface]];
  }

  if (conf.resolveType) {
    objTypeConf['resoveType'] = conf.resolveType;
  }

  let objType: any;

  if (conf.isInterface) {
    objType = new GraphQLInterfaceType(objTypeConf);
    interfaceTypes[conf.name] = objType;
  } else {
    objType = new GraphQLObjectType(objTypeConf);
    schemaTypes[conf.name] = objType;
  }

  return objType;
};

const jsonType = new GraphQLScalarType({
  name: 'JSON',
  serialize: JSON.stringify,
});

const schemaTypes: any = {};
const interfaceTypes: any = {};

createSchemaType(schemaTypes, interfaceTypes, {
  name: 'Permission',
  version: '1',
  // isInterface: true,
  // resolveType: ({ service }: any): GraphQLObjectType => {
  //   switch (service) {
  //     case 'aws-analytics': return schemaTypes['PermissionAWSAnalyticsType'];
  //     case 'github-org': return schemaTypes['PermissionGithubOrgType'];
  //     case 'github-org-team': return schemaTypes['PermissionGithubOrgTeamType'];
  //     case 'openshift-rolebinding': return schemaTypes['PermissionOpenshiftRolebindingType'];
  //     case 'quay-membership': return schemaTypes['PermissionQuayOrgTeamType'];
  //   }
  // },
  fields: [
    { name: 'service', type: GraphQLString, isRequired: true },
  ],
});

createSchemaType(schemaTypes, interfaceTypes, {
  name: 'PermissionAWSAnalytics',
  version: '1',
  fields: [
    { name: 'service', type: GraphQLString, isRequired: true },
  ],
});

createSchemaType(schemaTypes, interfaceTypes, {
  name: 'User',
  version: '1',
  fields: [
    { name: 'schema', type: GraphQLString, isRequired: true },
    { name: 'path', type: GraphQLString, isRequired: true },
    { name: 'labels', type: jsonType },
    { name: 'name', type: GraphQLString, isRequired: true },
    { name: 'redhat_username', type: GraphQLString, isRequired: true },
    { name: 'github_username', type: GraphQLString, isRequired: true },
    { name: 'quay_username', type: GraphQLString },
  ],
});

createSchemaType(schemaTypes, interfaceTypes, {
  name: 'Bot',
  version: '1',
  fields: [
    { name: 'schema', type: GraphQLString, isRequired: true },
    { name: 'path', type: GraphQLString, isRequired: true },
    { name: 'labels', type: jsonType },
    { name: 'name', type: GraphQLString, isRequired: true },
    { name: 'github_username', type: GraphQLString },
    { name: 'quay_username', type: GraphQLString },
    { name: 'owner', type: 'User' },
  ],
});

createSchemaType(schemaTypes, interfaceTypes, {
  name: 'Role',
  version: '1',
  datafile: '/access/role-1.yml',
  fields: [
    { name: 'schema', type: GraphQLString, isRequired: true },
    { name: 'path', type: GraphQLString, isRequired: true },
    { name: 'labels', type: jsonType },
    { name: 'name', type: GraphQLString, isRequired: true },
    {
      name: 'users',
      type: 'User',
      isList: true,
      synthetic: { schema: '/access/user-1.yml', subAttr: 'roles' },
    },
    {
      name: 'bots',
      type: 'Bot',
      isList: true,
      synthetic: { schema: '/access/bot-1.yml', subAttr: 'roles' },
    },
  ],
});

createSchemaType(schemaTypes, interfaceTypes, {
  name: 'Query',
  fields: [
    { name: 'user', type: 'User', isList: true, datafileSchema: '/access/user-1.yml' },
    { name: 'bot', type: 'Bot', isList: true, datafileSchema: '/access/bot-1.yml' },
    { name: 'role', type: 'Role', isList: true, datafileSchema: '/access/role-1.yml' },
  ],
});

export const appSchema = new GraphQLSchema({
  types: Object.values(schemaTypes),
  query: schemaTypes['Query'],
});
