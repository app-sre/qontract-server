import * as express from 'express';

import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLError,
} from 'graphql';

import * as db from './db';
import { Datafile } from './types';

const isRef = (obj: Object): boolean => obj.constructor === Object && Object.keys(obj).length === 1 && '$ref' in obj;

// object types helpers
const addObjectType = (app: express.Express, bundleSha: string, name: string, obj: any) => {
  if (typeof (app.get('objectTypes')[bundleSha]) === 'undefined') {
    app.get('objectTypes')[bundleSha] = {}; // eslint-disable-line no-param-reassign
  }
  app.get('objectTypes')[bundleSha][name] = obj; // eslint-disable-line no-param-reassign
};

const getObjectType = (app: express.Express, bundleSha: string, name: string) => app.get('objectTypes')[bundleSha][name];

const jsonType = new GraphQLScalarType({
  name: 'JSON',
  serialize: JSON.stringify,
});

type FilterPredicate = (source: any) => boolean; // eslint-disable-line no-unused-vars

type FilterPredicateBuilder = (value: any) => FilterPredicate; // eslint-disable-line no-unused-vars

class Filter {
  constructor(
    public predicateBuilder: FilterPredicateBuilder,
    public gqlType: any,
  ) {
    this.predicateBuilder = predicateBuilder;
    this.gqlType = gqlType;
  }
}

interface FilterDict {
  [key: string]: Filter;
}

const falsePredicate = (_: any): boolean => false; // eslint-disable-line no-unused-vars

const truePredicate = (_: any): boolean => true; // eslint-disable-line no-unused-vars

const fieldEqPredicate = (field: string, value: any, source: any): boolean => (
  (source[field] ?? null) === value
);

const fieldEqPredicateIgnoreNullBuilder = (field: string) : FilterPredicateBuilder => (
  (value: any): FilterPredicate => (
    value === null
      ? truePredicate
      : fieldEqPredicate.bind(null, field, value)
  )
);

const containsPredicate = (field: string, value: Set<string>, source: any): boolean => (
  field in source && value.has(source[field])
);

const filterObjectPredicateBuilder = (gqlType: any): FilterPredicateBuilder => (
  (filterObject: any): FilterPredicate => {
    const supportedFieldsInSchema = new Set(
      gqlType.fields.filter(
        (f: any) => ['string', 'int', 'boolean'].includes(f.type),
      ).map(
        (f: any) => f.name,
      ),
    );
    if (typeof filterObject !== 'object') return falsePredicate;
    const filters: FilterPredicate[] = Object.entries(filterObject).map(([field, value]) => {
      switch (true) {
        case !supportedFieldsInSchema.has(field):
          throw new GraphQLError(
            `Field ${field} on ${gqlType.name} can not be used for filtering (yet)`,
            undefined,
            null,
            null,
            null,
            null,
            {
              code: 'BAD_FILTER_FIELD',
              gqlType: gqlType.name,
            },
          );
        case Array.isArray(value):
          return containsPredicate.bind(null, field, new Set(value as Array<string>));
        default:
          return fieldEqPredicate.bind(null, field, value);
      }
    });
    return (source: any): boolean => filters.every((f) => f(source));
  }
);

const registerFilterArgs = (
  app: express.Express,
  bundleSha: string,
  gqlType: any,
  fields: string[],
) => {
  if (typeof (app.get('searchableFields')[bundleSha]) === 'undefined') {
    app.get('searchableFields')[bundleSha] = {}; // eslint-disable-line no-param-reassign
  }

  const filters: FilterDict = {};

  // searchable fields + path
  [...fields, 'path'].forEach((field) => {
    filters[field] = new Filter(
      fieldEqPredicateIgnoreNullBuilder(field),
      GraphQLString,
    );
  });

  // generic filter object
  filters.filter = new Filter(
    filterObjectPredicateBuilder(gqlType),
    jsonType,
  );

  app.get('searchableFields')[bundleSha][gqlType.name] = filters; // eslint-disable-line no-param-reassign
};

const getFilters = (
  app: express.Express,
  bundleSha: string,
  name: string,
): FilterDict => app.get('searchableFields')[bundleSha][name];

// interface types helpers
const addInterfaceType = (app: express.Express, bundleSha: string, name: string, obj: any) => {
  if (typeof (app.get('objectInterfaces')[bundleSha]) === 'undefined') {
    app.get('objectInterfaces')[bundleSha] = {}; // eslint-disable-line no-param-reassign
  }
  app.get('objectInterfaces')[bundleSha][name] = obj; // eslint-disable-line no-param-reassign
};

const getInterfaceType = (app: express.Express, bundleSha: string, name: string) => app.get('objectInterfaces')[bundleSha][name];

// datafile types to GraphQL type
const addDatafileSchema = (
  app: express.Express,
  bundleSha: string,
  datafileSchema: string,
  graphqlType: string,
) => {
  if (typeof (app.get('datafileSchemas')[bundleSha]) === 'undefined') {
    app.get('datafileSchemas')[bundleSha] = {}; // eslint-disable-line no-param-reassign
  }
  app.get('datafileSchemas')[bundleSha][datafileSchema] = graphqlType; // eslint-disable-line no-param-reassign
};

const getGraphqlTypeForDatafileSchema = (
  app: express.Express,
  bundleSha: string,
  datafileSchema: string,
) => app.get('datafileSchemas')[bundleSha][datafileSchema];

// helpers
const isNonEmptyArray = (obj: any) => obj.constructor === Array && obj.length > 0;

// synthetic field resolver
const resolveSyntheticField = (
  bundle: db.Bundle,
  path: string,
  schema: string,
  subAttr: string,
): Datafile[] => bundle.syntheticBackRefTrie.getDatafiles(schema, subAttr.split('.'), path);

const resolveDatafileSchemaField = (
  bundle: db.Bundle,
  schema: string,
  searchableFields: FilterDict,
  args: any,
): Datafile[] => {
  // that get is not guaranteed to return a value so if it doesn't, we will just return
  // undefined from the function rather than cause an error
  const datafiles = bundle.datafilesBySchema.get(schema);

  if (!datafiles) return [];

  const filterArgs = Object.entries(args)
    .filter(([_, value]) => value != null); // eslint-disable-line no-unused-vars

  const predicates = filterArgs.map(
    ([key, value]) => searchableFields[key].predicateBuilder(value),
  );
  return datafiles
    .filter((df: Datafile) => predicates.every((predicate) => predicate(df)));
};

// default resolver
export const defaultResolver = (
  app: express.Express,
  bundleSha: string,
) => (root: any, args: any, context: any, info: any) => {
  // add root.$schema to the schemas extensions
  if (typeof (root.$schema) !== 'undefined' && root.$schema) {
    if ('schemas' in context) {
      if (!context.schemas.includes(root.$schema)) {
        context.schemas.push(root.$schema);
      }
    } else {
      context.schemas = [root.$schema];
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
    let arrayResolve = val.map((x: db.Referencing) => db.resolveRef(app.get('bundles')[bundleSha], x));

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
  objTypeConf.name = conf.name;

  // searchable fields
  const searchableFieldNames = conf.fields
    .filter((f: any) => f.isSearchable && f.type === 'string')
    .map((f: any) => f.name);

  registerFilterArgs(app, bundleSha, conf, searchableFieldNames);

  // fields
  objTypeConf.fields = () => conf.fields.reduce(
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
        throw new Error(`fieldInfo type is undefined: ${JSON.stringify(fieldInfo)}`);
      }

      if (fieldInfo.isList) {
        // make list elements non nullable
        t = new GraphQLList(GraphQLNonNull(t));
      }

      if (fieldInfo.isRequired) {
        t = new GraphQLNonNull(t);
      }

      fieldDef.type = t;

      if (fieldInfo.datafileSchema) {
        // schema

        // add searchable fields
        // eslint-disable-next-line no-restricted-syntax
        const filterSpecs = getFilters(app, bundleSha, fieldInfo.type);
        fieldDef.args = Object.fromEntries(
          Object.entries(filterSpecs).map(
            ([searchableField, searchableFieldInfo]) => [
              searchableField,
              {
                type: searchableFieldInfo.gqlType,
              },
            ],
          ),
        );

        fieldDef.resolve = (root: any, args: any) => resolveDatafileSchemaField(
          app.get('bundles')[bundleSha],
          fieldInfo.datafileSchema,
          filterSpecs,
          args,
        );
      } else if (fieldInfo.synthetic) {
        // synthetic
        fieldDef.resolve = (root: any) => resolveSyntheticField(
          app.get('bundles')[bundleSha],
          root.path,
          fieldInfo.synthetic.schema,
          fieldInfo.synthetic.subAttr,
        );
      } else if (fieldInfo.isResource) {
        if (fieldInfo.type === 'string' && fieldInfo.resolveResource) {
          // a resource reference
          fieldDef.type = getObjectType(app, bundleSha, 'Resource_v1');
          fieldDef.resolve = (root: any) => {
            if (root[fieldInfo.name] !== undefined) {
              return app.get('bundles')[bundleSha].resourcefiles.get(root[fieldInfo.name]);
            }
            return null;
          };
        // eslint-disable-next-line eqeqeq
        } else if (fieldInfo.type == getObjectType(app, bundleSha, 'Resource_v1')) {
          // a resource
          fieldDef.args = { path: { type: GraphQLString }, schema: { type: GraphQLString } };
          fieldDef.resolve = (root: any, args: any) => {
            if (args.path) {
              return [app.get('bundles')[bundleSha].resourcefiles.get(args.path)];
            }

            let results = Array.from(app.get('bundles')[bundleSha].resourcefiles.values());

            if (args.schema) {
              results = results.filter((r: any) => r.$schema === args.schema);
            }

            return results;
          };
        }
      }

      // return
      objFields[fieldInfo.name] = fieldDef; // eslint-disable-line no-param-reassign
      return objFields;
    },
    {},
  );

  // interface
  if (conf.interface || conf.datafile) {
    objTypeConf.interfaces = () => [
      conf.interface ? getInterfaceType(app, bundleSha, conf.interface) : null,
      conf.datafile ? getInterfaceType(app, bundleSha, 'DatafileObject_v1') : null,
    ].filter((x) => x != null);
  }

  // generate resolveType for interfaces
  if (conf.isInterface) {
    let resolveType: any;

    switch (conf.interfaceResolve.strategy) {
      case 'fieldMap':
        resolveType = (source: any) => {
          const { field } = conf.interfaceResolve;
          const fieldValue = source[field];

          const { fieldMap } = conf.interfaceResolve;
          return getObjectType(app, bundleSha, fieldMap[fieldValue]);
        };
        break;
      case 'schema':
        resolveType = (source: any) => {
          const schema = source.$schema;
          const targetObjType = getGraphqlTypeForDatafileSchema(app, bundleSha, schema);
          return getObjectType(app, bundleSha, targetObjType);
        };
        break;
      default:
        throw new Error('strategy not implemented');
    }

    objTypeConf.resolveType = resolveType;
  }

  let objType: any;

  if (conf.isInterface) {
    objType = new GraphQLInterfaceType(objTypeConf);
    addInterfaceType(app, bundleSha, conf.name, objType);
  } else {
    objType = new GraphQLObjectType(objTypeConf);
    // eslint-disable-next-line eqeqeq
    if (conf.datafile != undefined) {
      addDatafileSchema(app, bundleSha, conf.datafile, conf.name);
    }
    addObjectType(app, bundleSha, conf.name, objType);
  }

  return objType;
};

export const generateAppSchema = (app: express.Express, bundleSha: string): GraphQLSchema => {
  let schemaData = app.get('bundles')[bundleSha].schema;

  if (typeof (schemaData.confs) !== 'undefined') {
    schemaData = schemaData.confs;
  }

  if (typeof (app.get('objectTypes')) === 'undefined') {
    app.set('objectTypes', {});
  }

  if (typeof (app.get('objectInterfaces')) === 'undefined') {
    app.set('objectInterfaces', {});
  }

  if (typeof (app.get('datafileSchemas')) === 'undefined') {
    app.set('datafileSchemas', {});
  }

  if (typeof (app.get('searchableFields')) === 'undefined') {
    app.set('searchableFields', {});
  }

  // populate searchable fields
  schemaData.map((gqlType: any) => registerFilterArgs(
    app,
    bundleSha,
    gqlType,
    gqlType.fields.filter((f: any) => f.isSearchable).map((f: any) => f.name),
  ));

  schemaData.map((t: any) => createSchemaType(app, bundleSha, t));

  return new GraphQLSchema({
    types: Object.values(app.get('objectTypes')[bundleSha]),
    query: getObjectType(app, bundleSha, 'Query'),
  });
};
