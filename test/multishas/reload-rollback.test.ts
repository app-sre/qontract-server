import * as http from 'http';
import * as express from 'express';
import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');

import * as server from '../../src/server';
import * as db from '../../src/db';

chai.use(chaiHttp);
const should = chai.should();

const query = `
  {
    resources_v1 {
      name
      ... on ResourceTypeA_v1 {
        resourceAField
      }
    }
  }`;

const queryWithNewField = `
  {
    resources_v1 {
      name
      newfield
      ... on ResourceTypeA_v1 {
        resourceAField
      }
    }
  }`;

const gql = (srv: http.Server, queryText: string, sha?: string) =>
  chai
    .request(srv)
    .post(sha ? `/graphqlsha/${sha}` : '/graphql')
    .set('content-type', 'application/json')
    .send({ query: queryText });

describe('reload rollback', () => {
  let srv: http.Server;
  let app: express.Express;
  const originalLoadMethod = process.env.LOAD_METHOD;
  const originalDatafilesFile = process.env.DATAFILES_FILE;

  before(async () => {
    process.env.LOAD_METHOD = 'fs';
    process.env.DATAFILES_FILE = 'test/multishas/multishas1.data.json';
    app = await server.appFromBundle([db.bundleFromEnvironment()]);
    srv = app.listen(0);
    await new Promise<void>((resolve) => srv.once('listening', resolve));
  });

  after(async () => {
    if (srv?.listening) {
      await new Promise<void>((resolve, reject) =>
        srv.close((error) => (error ? reject(error) : resolve())),
      );
    }

    if (originalLoadMethod === undefined) {
      delete process.env.LOAD_METHOD;
    } else {
      process.env.LOAD_METHOD = originalLoadMethod;
    }
    if (originalDatafilesFile === undefined) {
      delete process.env.DATAFILES_FILE;
    } else {
      process.env.DATAFILES_FILE = originalDatafilesFile;
    }
  });

  it('rolls back invalid schemas and preserves bundles until recovery', async () => {
    const historicalSha = app.get('latestBundleSha');

    process.env.DATAFILES_FILE = 'test/multishas/multishas2.data.json';
    const successfulReload = await chai.request(srv).post('/reload');
    successfulReload.should.have.status(200);
    const previousLatestSha = app.get('latestBundleSha');
    previousLatestSha.should.not.equal(historicalSha);

    app.get('bundleCache')[historicalSha].expiration = 0;
    process.env.DATAFILES_FILE =
      'test/multishas/multishas-invalid-schema.data.json';
    const candidateSha = (await db.bundleFromEnvironment()).fileHash;

    const firstReload = await chai.request(srv).post('/reload');
    const retryReload = await chai.request(srv).post('/reload');
    firstReload.should.have.status(503);
    retryReload.should.have.status(503);

    app.get('latestBundleSha').should.equal(previousLatestSha);
    should.equal(app.get('bundles')[candidateSha], undefined);
    should.equal(app.get('bundleCache')[candidateSha], undefined);
    should.equal(app.get('shaRouters').has(candidateSha), false);
    should.equal(app.get('objectTypes')[candidateSha], undefined);
    should.equal(app.get('objectInterfaces')[candidateSha], undefined);
    should.equal(app.get('searchableFields')[candidateSha], undefined);
    should.equal(app.get('datafileSchemas')[candidateSha], undefined);
    should.exist(app.get('bundles')[historicalSha]);

    const latestResponse = await gql(srv, queryWithNewField);
    latestResponse.should.have.status(200);
    latestResponse.body.data.resources_v1[0].name.should.equal('sha2');

    const historicalResponse = await gql(srv, query, historicalSha);
    historicalResponse.should.have.status(200);
    historicalResponse.body.data.resources_v1[0].name.should.equal('sha1');

    app.get('bundleCache')[historicalSha].expiration = 0;
    process.env.DATAFILES_FILE = 'test/multishas/multishas3.data.json';
    const recoveryReload = await chai.request(srv).post('/reload');
    recoveryReload.should.have.status(200);
    app.get('latestBundleSha').should.not.equal(previousLatestSha);

    const recoveredResponse = await gql(srv, queryWithNewField);
    recoveredResponse.should.have.status(200);
    recoveredResponse.body.data.resources_v1[0].name.should.equal('sha3');

    should.equal(app.get('bundles')[historicalSha], undefined);
    should.equal(app.get('bundleCache')[historicalSha], undefined);
    should.equal(app.get('shaRouters').has(historicalSha), false);
    should.equal(app.get('objectTypes')[historicalSha], undefined);
    should.equal(app.get('objectInterfaces')[historicalSha], undefined);
    should.equal(app.get('searchableFields')[historicalSha], undefined);
    should.equal(app.get('datafileSchemas')[historicalSha], undefined);
  });
});
