const yaml = require('js-yaml');
const fs = require('fs');

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

const isRef = function (obj: any) {
  if (obj.constructor === Object) {
    if (Object.keys(obj).length === 1 && ('$ref' in obj)) {
      return true;
    }
  }
  return false;
};

const isNonEmptyArray = (obj: any) => obj.constructor === Array && obj.length > 0;

const resolveSyntheticField = (root: any, schema: string, subAttr: string) =>
  db.getDatafilesBySchema(schema).filter((e: any) => {
    if (subAttr in e) {
      const backrefs = e[subAttr].map((r: any) => r.$ref);
      return backrefs.includes(root.path);
    }
    return false;
  });

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

const createSchemaType = function (schemaTypes: any, interfaceTypes: any, conf: any) {
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
        fieldDef['resolve'] = () => db.getDatafilesBySchema(fieldInfo.datafileSchema);
      } else if (fieldInfo.synthetic) {
        // synthetic
        fieldDef['resolve'] = (root: any) => resolveSyntheticField(
          root,
          fieldInfo.synthetic.schema,
          fieldInfo.synthetic.subAttr,
        );
      } else if (fieldInfo.isResource) {
        // resource
        fieldDef['args'] = { path: { type: GraphQLString } };
        fieldDef['resolve'] = (root: any, args: any) => {
          if (args.path) {
            return [db.getResource(args.path)];
          }
          return db.getResources();
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

export function generateAppSchema(path: string): GraphQLSchema {
  const schemaData = yaml.safeLoad(fs.readFileSync(path, 'utf8'));

  const schemaTypes: any = {};
  const interfaceTypes: any = {};


  schemaData.map((t: any) => createSchemaType(schemaTypes, interfaceTypes, t));
  console.log(interfaceTypes);

  return new GraphQLSchema({
    types: Object.values(schemaTypes),
    query: schemaTypes['Query'],
  });
}
