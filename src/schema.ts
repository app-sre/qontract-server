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

const isRef = (obj: Object): boolean => {
  return obj.constructor === Object && Object.keys(obj).length === 1 && '$ref' in obj;
};

// object types helpers
const addObjectType = (app: express.Express, bundleSha: string, name: string, obj: any) => {
  if (typeof (app.get('objectTypes')[bundleSha]) === 'undefined') {
    app.get('objectTypes')[bundleSha] = {};
  }
  app.get('objectTypes')[bundleSha][name] = obj;
};

const getObjectType = (app: express.Express, bundleSha: string, name: string) => {
  return app.get('objectTypes')[bundleSha][name];
};

// searchable fields helpers
const addSearchableFields =
  (app: express.Express, bundleSha: string, name: string, fields: any) => {
    if (typeof (app.get('searchableFields')[bundleSha]) === 'undefined') {
      app.get('searchableFields')[bundleSha] = {};
    }
    app.get('searchableFields')[bundleSha][name] = fields;
  };

const getSearchableFields = (app: express.Express, bundleSha: string, name: string) => {
  return app.get('searchableFields')[bundleSha][name];
};

// interface types helpers
const addInterfaceType = (app: express.Express, bundleSha: string, name: string, obj: any) => {
  if (typeof (app.get('objectInterfaces')[bundleSha]) === 'undefined') {
    app.get('objectInterfaces')[bundleSha] = {};
  }
  app.get('objectInterfaces')[bundleSha][name] = obj;
};

const getInterfaceType = (app: express.Express, bundleSha: string, name: string) =>
  app.get('objectInterfaces')[bundleSha][name];

// helpers
const isNonEmptyArray = (obj: any) => obj.constructor === Array && obj.length > 0;

// synthetic field resolver
const resolveSyntheticField = (app: express.Express,
                               bundleSha: string,
                               path: string,
                               schema: string,
                               subAttr: string): db.Datafile[] =>
  Array.from(app.get('bundles')[bundleSha].datafiles.filter((datafile: any) => {

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

// default resolver
export const defaultResolver = (app: express.Express, bundleSha: string) =>
  (root: any, args: any, context: any, info: any) => {
    // add root.$schema to the schemas extensions
    if (typeof (root.$schema) !== 'undefined') {
      if ('schemas' in context) {
        if (!context.schemas.includes(root.$schema)) {
          context['schemas'].push(root.$schema);
        }
      } else {
        context['schemas'] = [root.$schema];
      }
    }

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
      let arrayResolve = val.map((x: db.Referencing) =>
        db.resolveRef(app.get('bundles')[bundleSha], x));

      // `info.returnType` has information about what the GraphQL schema expects
      // as a return type. If it starts with `[` it means that we need to return
      // an array.
      if (String(info.returnType)[0] === '[') {
        arrayResolve = arrayResolve.flat(1);
      }

      return arrayResolve;
    }

    if (isRef(val)) return db.resolveRef(app.get('bundles')[bundleSha], val);
    return val;
  };

// ------------------ START SCHEMA ------------------

const createSchemaType = (app: express.Express, bundleSha: string, conf: any) => {
  const objTypeConf: any = {};

  // name
  objTypeConf['name'] = conf.name;

  // searchable fields
  const searchableFields = conf.fields
    .filter((f: any) => f.isSearchable && f.type === 'string')
    .map((f: any) => f.name);

  addSearchableFields(app, bundleSha, conf.name, searchableFields);

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
              t = getInterfaceType(app, bundleSha, t);
            } else {
              t = getObjectType(app, bundleSha, t);
            }
        }
      }

      if (typeof (t) === 'undefined') {
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

        // path is always a searchable field
        fieldDef['args'] = { path: { type: GraphQLString } };

        // add other searchable fields
        for (const searchableField of getSearchableFields(app, bundleSha, fieldInfo.type)) {
          fieldDef['args'][searchableField] = { type: GraphQLString };
        }

        fieldDef['resolve'] = (root: any, args: any) => {
          return Array.from(app.get('bundles')[bundleSha].datafiles.filter(
            (df: db.Datafile) => {
              if (df.$schema !== fieldInfo.datafileSchema) {
                return false;
              }
              for (const key of Object.keys(args)) {
                if (!(key in df) || args[key] !== df[key]) {
                  return false;
                }
              }
              return true;
            }).values());
        };
      } else if (fieldInfo.synthetic) {
        // synthetic
        fieldDef['resolve'] = (root: any) => resolveSyntheticField(
          app,
          bundleSha,
          root.path,
          fieldInfo.synthetic.schema,
          fieldInfo.synthetic.subAttr,
        );
      } else if (fieldInfo.isResource) {
        // resource
        fieldDef['args'] = { path: { type: GraphQLString } };
        fieldDef['resolve'] = (root: any, args: any) =>
          args.path ?
            [app.get('bundles')[bundleSha].resourcefiles.get(args.path)] :
            Array.from(app.get('bundles')[bundleSha].resourcefiles.values());
      }

      // return
      objFields[fieldInfo.name] = fieldDef;
      return objFields;
    },
    {},
  );

  // interface
  if (conf.interface) {
    objTypeConf['interfaces'] = () => [getInterfaceType(app, bundleSha, conf.interface)];
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
          return getObjectType(app, bundleSha, fieldMap[fieldValue]);
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
    addInterfaceType(app, bundleSha, conf.name, objType);
  } else {
    objType = new GraphQLObjectType(objTypeConf);
    addObjectType(app, bundleSha, conf.name, objType);
  }

  return objType;
};

const jsonType = new GraphQLScalarType({
  name: 'JSON',
  serialize: JSON.stringify,
});

export const generateAppSchema = (app: express.Express, bundleSha: string): GraphQLSchema => {
  const schemaData = app.get('bundles')[bundleSha].schema;

  if (typeof (app.get('objectTypes')) === 'undefined') {
    app.set('objectTypes', {});
  }

  if (typeof (app.get('objectInterfaces')) === 'undefined') {
    app.set('objectInterfaces', {});
  }

  if (typeof (app.get('searchableFields')) === 'undefined') {
    app.set('searchableFields', {});
  }

  // populate searchable fields
  schemaData.map((gqlType: any) => addSearchableFields(
    app, bundleSha, gqlType.name,
    gqlType.fields.filter((f: any) => f.isSearchable).map((f: any) => f.name)));

  schemaData.map((t: any) => createSchemaType(app, bundleSha, t));

  return new GraphQLSchema({
    types: Object.values(app.get('objectTypes')[bundleSha]),
    query: getObjectType(app, bundleSha, 'Query'),
  });
};
