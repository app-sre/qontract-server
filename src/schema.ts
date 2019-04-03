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

const addObjectType = (app: express.Express, name: string, obj: any) => {
  const t: any = {};
  t[name] = obj;
  app.set('objectTypes', Object.assign(app.get('objectTypes'), t));
};

const getObjectType = (app: express.Express, name: string) =>
  app.get('objectTypes')[name];

const addInterfaceType = (app: express.Express, name: string, obj: any) => {
  const t: any = {};
  t[name] = obj;
  app.set('objectInterfaces', Object.assign(app.get('objectInterfaces'), t));
};

const getInterfaceType = (app: express.Express, name: string) =>
  app.get('objectInterfaces')[name];

const isNonEmptyArray = (obj: any) => obj.constructor === Array && obj.length > 0;

const resolveSyntheticField = (app: express.Express,
                               path: string,
                               schema: string,
                               subAttr: string) : db.Datafile[] =>
  Array.from(app.get('bundle').datafiles.filter((datafile: any) => {

    if (datafile.$schema !== schema) { return false; }

    if (subAttr in datafile) {
      const subAttrVal = datafile[subAttr];

      // the attribute is a list of $refs
      if (Array.isArray(subAttrVal)) {
        const backrefs = datafile[subAttr].map((r: any) => r.$ref);
        return backrefs.includes(path);
      }

      // the attribute is a single $ref
      if (subAttrVal.$ref === path) {
        return true;
      }
    }
    return false;
  }).values());

export const defaultResolver = (app: express.Express) => (root: any,
                                                          args: any,
                                                          context: any,
                                                          info: any) => {
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
    let arrayResolve = val.map((x: db.Referencing) => db.resolveRef(app.get('bundle'), x));

    // `info.returnType` has information about what the GraphQL schema expects
    // as a return type. If it starts with `[` it means that we need to return
    // an array.
    if (String(info.returnType)[0] === '[') {
      arrayResolve = arrayResolve.flat(1);
    }

    return arrayResolve;
  }

  if (isRef(val)) return db.resolveRef(app.get('bundle'), val);
  return val;
};

// ------------------ START SCHEMA ------------------

const createSchemaType = (app: express.Express, conf: any) => {
  const objTypeConf: any = {};

  // name
  objTypeConf['name'] = conf.name;

  // fields
  objTypeConf['fields'] = () => conf.fields.reduce(
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
              t = getInterfaceType(app, t);
            } else {
              t = getObjectType(app, t);
            }
        }
      }

      if (typeof(t) === 'undefined') {
        throw `fieldInfo type is undefined: ${JSON.stringify(fieldInfo)}`;
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
          return Array.from(app.get('bundle').datafiles.filter(
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
        fieldDef['resolve'] = (root: any, args: any) =>
          args.path ?
            [app.get('bundle').resourcefiles.get(args.path)] :
            Array.from(app.get('bundle').resourcefiles.values());
      }

      // return
      objFields[fieldInfo.name] = fieldDef;
      return objFields;
    },
    {},
  );

  // interface
  if (conf.interface) {
    objTypeConf['interfaces'] = () => [getInterfaceType(app, conf.interface)];
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
          return getObjectType(app, fieldMap[fieldValue]);
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
    addInterfaceType(app, conf.name, objType);
  } else {
    objType = new GraphQLObjectType(objTypeConf);
    addObjectType(app, conf.name, objType);
  }

  return objType;
};

const jsonType = new GraphQLScalarType({
  name: 'JSON',
  serialize: JSON.stringify,
});

export const generateAppSchema = (app: express.Express) : GraphQLSchema => {
  const schemaData = app.get('bundle').schema;

  app.set('objectTypes', {});
  app.set('objectInterfaces', {});

  schemaData.map((t: any) => createSchemaType(app, t));

  return new GraphQLSchema({
    types: Object.values(app.get('objectTypes')),
    query: getObjectType(app, 'Query'),
  });
};
