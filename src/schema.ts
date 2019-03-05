import * as fs from 'fs';

import * as express from 'express';
import * as yaml from 'js-yaml';

import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLInterfaceType,
} from 'graphql';

import * as db from './db';

const isRef = (obj: Object) : boolean => {
  return obj.constructor === Object && Object.keys(obj).length === 1 && '$ref' in obj;
};

const isNonEmptyArray = (obj: any) => obj.constructor === Array && obj.length > 0;

const resolveSyntheticField = (app: express.Express,
                               path: string,
                               schema: string,
                               subAttr: string) : db.Datafile[] => {
  const bundle = app.get('bundle');
  return Array.from(bundle.datafiles.filter((datafile: any) => {

    if (datafile.$schema !== schema) { return false; }

    if (subAttr in datafile) {
      const backrefs = datafile[subAttr].map((r: any) => r.$ref);
      return backrefs.includes(path);
    }
    return false;
  }).values());
};

export const defaultResolver = (app: express.Express) => (root: any,
                                                          args: any,
                                                          context: any,
                                                          info: any) => {
  const bundle = app.get('bundle');

  if (info.fieldName === 'schema') return root.$schema;

  const val = root[info.fieldName];

  // if the item is null, return as is
  if (typeof (val) === 'undefined') { return null; }

  if (isNonEmptyArray(val)) {
    // are all the elements of this array references?
    const checkRefs = val.map(isRef);

    // if there are elements that aren't references return the array as is
    if (checkRefs.includes(false)) {
      return val;
    }

    // resolve all the elements of the array
    let arrayResolve = val.map((x: db.Referencing) => db.resolveRef(bundle, x));

    // `info.returnType` has information about what the GraphQL schema expects
    // as a return type. If it starts with `[` it means that we need to return
    // an array.
    if (String(info.returnType)[0] === '[') {
      arrayResolve = arrayResolve.flat(1);
    }

    return arrayResolve;
  }

  if (isRef(val)) return db.resolveRef(bundle, val);
  return val;
};

// ------------------ START SCHEMA ------------------

const createSchemaType = (app: express.Express,
                          schemaTypes: any,
                          interfaceTypes: any,
                          conf: any) => {

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
      let t: any = fieldInfo.type;

      if (typeof t === 'string') {
        switch (t) {
          case 'string':
            t = GraphQLString;
            break;
          case 'float':
            t = GraphQLFloat;
            break;
          case 'boolean':
            t = GraphQLBoolean;
            break;
          case 'int':
            t = GraphQLInt;
            break;
          case 'json':
            t = jsonType;
            break;
          default:
            if (fieldInfo.isInterface) {
              t = interfaceTypes[t];
            } else {
              t = schemaTypes[t];
            }
        }
      }

      if (fieldInfo.isRequired) {
        t = new GraphQLNonNull(t);
      }

      if (fieldInfo.isList) {
        t = new GraphQLList(t);
      }

      fieldDef['type'] = t;

      if (fieldInfo.datafileSchema) {
        // schema
        fieldDef['args'] = { path: { type: GraphQLString } };
        fieldDef['resolve'] = (root: any, args: any) => {
          const bundle: db.Bundle = app.get('bundle');

          return Array.from(bundle.datafiles.filter(
            (df: db.Datafile) => {
              const sameSchema: boolean = df.$schema === fieldInfo.datafileSchema;
              return args.path ? df.path === args.path && sameSchema : sameSchema;
            }).values());
        };
      } else if (fieldInfo.synthetic) {
        // synthetic
        fieldDef['resolve'] = (root: any) => resolveSyntheticField(
          app,
          root.path,
          fieldInfo.synthetic.schema,
          fieldInfo.synthetic.subAttr,
        );
      } else if (fieldInfo.isResource) {
        // resource
        fieldDef['args'] = { path: { type: GraphQLString } };
        fieldDef['resolve'] = (root: any, args: any) => {
          const bundle: db.Bundle = app.get('bundle');
          return args.path ?
            [bundle.resourcefiles.get(args.path)] :
            Array.from(bundle.resourcefiles.values());
        };
      }

      // return
      objFields[fieldInfo.name] = fieldDef;
      return objFields;
    },
    {},
  );

  // interface
  if (conf.interface) {
    objTypeConf['interfaces'] = [interfaceTypes[conf.interface]];
  }

  // generate resolveType for interfaces
  if (conf.isInterface) {
    let resolveType: any;

    switch (conf.interfaceResolve.strategy) {
      case 'fieldMap':
        resolveType = (source: any) => {
          const field = conf.interfaceResolve.field;
          const fieldValue = source[field];

          const fieldMap = conf.interfaceResolve.fieldMap;
          return schemaTypes[fieldMap[fieldValue]];
        };
        break;
      default:
        throw new Error('strategy not implemented');
    }

    objTypeConf['resolveType'] = resolveType;
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

const resourceType = new GraphQLObjectType({
  name: 'Resource_v1',
  fields: {
    sha256sum: { type: new GraphQLNonNull(GraphQLString) },
    path: { type: new GraphQLNonNull(GraphQLString) },
    content: { type: new GraphQLNonNull(GraphQLString) },
  },
});

export const generateAppSchema = (app: express.Express, contents: string) : GraphQLSchema => {
  const schemaData = yaml.safeLoad(contents);

  const schemaTypes: any = {};
  const interfaceTypes: any = {};

  schemaData.map((t: any) => createSchemaType(app, schemaTypes, interfaceTypes, t));

  return new GraphQLSchema({
    types: Object.values(schemaTypes),
    query: schemaTypes['Query'],
  });
};
