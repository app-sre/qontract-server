import express = require('express');
import {
  graphql,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';
import * as chai from 'chai';

import { defaultResolver } from '../src/schema';

const { expect } = chai;

describe('default resolver', () => {
  const app = express();
  const bundleSha = 'test';
  app.set('bundles', {
    [bundleSha]: {
      datafiles: new Map([['/referenced.yml', { name: 'from reference' }]]),
    },
  });

  const resolver = defaultResolver(app, bundleSha);
  const Child = new GraphQLObjectType({
    name: 'Child',
    fields: {
      name: { type: GraphQLString, resolve: resolver },
    },
  });
  const Query = new GraphQLObjectType({
    name: 'Query',
    fields: {
      optionalScalar: { type: GraphQLString, resolve: resolver },
      optionalObject: { type: Child, resolve: resolver },
      missing: { type: GraphQLString, resolve: resolver },
      populatedScalar: { type: GraphQLString, resolve: resolver },
      populatedObject: { type: Child, resolve: resolver },
      referencedObject: { type: Child, resolve: resolver },
      values: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
        resolve: resolver,
      },
    },
  });
  const schema = new GraphQLSchema({ query: Query });

  it('returns explicit null and preserves existing resolver behavior', async () => {
    const result = await graphql({
      schema,
      source:
        '{ optionalScalar optionalObject { name } missing populatedScalar populatedObject { name } referencedObject { name } }',
      rootValue: {
        optionalScalar: null,
        optionalObject: null,
        populatedScalar: 'present',
        populatedObject: { name: 'nested' },
        referencedObject: { $ref: '/referenced.yml' },
      },
      contextValue: { schemas: [] },
    });

    expect(result.errors).to.equal(undefined);
    expect(result.data).to.deep.equal({
      optionalScalar: null,
      optionalObject: null,
      missing: null,
      populatedScalar: 'present',
      populatedObject: { name: 'nested' },
      referencedObject: { name: 'from reference' },
    });
  });

  it('leaves list element nullability enforcement to GraphQL', async () => {
    const result = await graphql({
      schema,
      source: '{ values }',
      rootValue: { values: ['present', null] },
      contextValue: { schemas: [] },
    });

    expect(result.errors?.map((error) => error.message)).to.deep.equal([
      'Cannot return null for non-nullable field Query.values.',
    ]);
    expect(result.data).to.deep.equal({ values: null });
  });
});
