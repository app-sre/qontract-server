import * as http from 'http';

import * as chai from 'chai';
import chaiHttp = require('chai-http');
import express = require('express');
import { GraphQLList, GraphQLString } from 'graphql';

import * as server from '../../src/server';
import * as db from '../../src/db';
import { defaultResolver } from '../../src/schema';

chai.use(chaiHttp);
const { expect } = chai;

describe('mixed reference lists', () => {
  let srv: http.Server;
  before(async () => {
    process.env.LOAD_METHOD = 'fs';
    process.env.DATAFILES_FILE = 'test/mixedref/data.json';
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 0 });
  });

  for (const [field, names] of [
    ['mixed', ['first', 'inline', 'second']],
    ['refs', ['first', 'second']],
    ['inline', ['inline-first', 'inline-second']],
  ] as const) {
    it(`resolves ${field} entries in order`, async () => {
      const resp = await chai
        .request(srv)
        .post('/graphql')
        .send({
          query: `{ collections { ${field} { name } } }`,
        });
      expect(resp).to.have.status(200);
      expect(resp.body).not.to.have.property('errors');
      expect(resp.body.data.collections[0][field]).to.deep.equal(
        names.map((name) => ({ name })),
      );
    });
  }

  it('reports a broken reference at its index in the non-nullable list', async () => {
    const resp = await chai.request(srv).post('/graphql').send({
      query: '{ collections { broken { name } } }',
    });
    expect(resp).to.have.status(200);
    expect(resp.body.data.collections[0].broken).to.equal(null);
    expect(resp.body.errors).to.have.length(1);
    expect(resp.body.errors[0].path).to.deep.equal([
      'collections',
      0,
      'broken',
      1,
    ]);
  });
});

describe('reference-array flattening', () => {
  const referenced = [{ name: 'first' }, { name: 'second' }];
  const inline = ['inline-array'];
  const app = express();
  app.set('bundles', {
    test: { datafiles: new Map([['/group.yml', referenced]]) },
  });
  const resolve = defaultResolver(app, 'test');

  for (const [description, returnType, expected] of [
    [
      'flattens only referenced arrays in list fields',
      new GraphQLList(GraphQLString),
      [...referenced, inline],
    ],
    [
      'preserves referenced and inline arrays in scalar fields',
      GraphQLString,
      [referenced, inline],
    ],
  ] as const) {
    it(description, () => {
      const result = resolve(
        { items: [{ $ref: '/group.yml' }, inline] },
        {},
        {},
        { fieldName: 'items', returnType },
      );
      expect(result).to.deep.equal(expected);
      expect(result[result.length - 1]).to.equal(inline);
    });
  }
});
