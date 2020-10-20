import * as http from 'http';
import * as express from 'express';
import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');
chai.use(chaiHttp);

import * as server from '../../src/server';
import * as db from '../../src/db';

const should = chai.should();

const gql = (srv: http.Server, query: string, sha?: string) => {
  let url;
  if (typeof (sha) === 'undefined') {
    url = '/graphql';
  } else {
    url = `/graphqlsha/${sha}`;
  }

  return chai.request(srv)
    .post(url)
    .set('content-type', 'application/json')
    .send({ query });
};

describe('multishas', async () => {
  let srv: http.Server;
  let app: express.Express;

  before(async () => {
    process.env.LOAD_METHOD = 'fs';
    process.env.DATAFILES_FILE = 'test/multishas/multishas1.data.json';

    app = await server.appFromBundle(db.bundleFromEnvironment());
    srv = app.listen({ port: 4000 });
  });

  const query = `
    {
      resources_v1 {
        name
        ... on ResourceTypeA_v1 {
          resourceAField
        }
      }
    }`;

  const query2 = `
    {
      resources_v1 {
        name
        newfield
        ... on ResourceTypeA_v1 {
          resourceAField
        }
      }
    }`;

  it('serves a basic graphql query', async () => {
    const resp = await gql(srv, query);
    resp.should.have.status(200);
    resp.body.data.resources_v1[0].name.should.equal('sha1');
    resp.body.data.resources_v1[0].resourceAField.should.equal('sha1');
  });

  it('serves a basic graphql query using GET', async () => {
    const resp = await chai.request(srv)
                        .get('/graphql')
                        .query({ query });
    resp.should.have.status(200);
    resp.body.data.resources_v1[0].name.should.equal('sha1');
    resp.body.data.resources_v1[0].resourceAField.should.equal('sha1');
  });

  it('reloads and works', async () => {
    const reloadResp = await chai.request(srv).post('/reload');
    reloadResp.should.have.status(200);

    const resp = await gql(srv, query);
    resp.should.have.status(200);
    resp.body.data.resources_v1[0].name.should.equal('sha1');
    resp.body.data.resources_v1[0].resourceAField.should.equal('sha1');
  });

  it('bad bundle reload is ignored and continues working', async () => {
    process.env.DATAFILES_FILE = 'test/multishas/multishas-invalid.data.json';
    const reloadResp = await chai.request(srv).post('/reload');
    reloadResp.should.have.status(503);

    const resp = await gql(srv, query);
    resp.should.have.status(200);
    resp.body.data.resources_v1[0].name.should.equal('sha1');
    resp.body.data.resources_v1[0].resourceAField.should.equal('sha1');
  });

  it('loads new data and works', async () => {
    process.env.DATAFILES_FILE = 'test/multishas/multishas2.data.json';
    await chai.request(srv).post('/reload');

    const resp = await gql(srv, query2);
    resp.should.have.status(200);
    resp.body.data.resources_v1[0].name.should.equal('sha2');
    resp.body.data.resources_v1[0].resourceAField.should.equal('sha2');
    resp.body.data.resources_v1[0].newfield.should.equal('sha2');
  });

  it('access via sha1', async () => {
    const sha: string = Object.keys(app.get('bundles'))[0];
    const resp = await gql(srv, query, sha);
    resp.should.have.status(200);
    resp.body.data.resources_v1[0].name.should.equal('sha1');
    resp.body.data.resources_v1[0].resourceAField.should.equal('sha1');
  });

  it('access via sha2', async () => {
    const sha: string = Object.keys(app.get('bundles'))[1];
    const resp = await gql(srv, query2, sha);
    resp.should.have.status(200);
    resp.body.data.resources_v1[0].name.should.equal('sha2');
    resp.body.data.resources_v1[0].resourceAField.should.equal('sha2');
    resp.body.data.resources_v1[0].newfield.should.equal('sha2');
  });

  it('removes expired bundle', async () => {
    const sha: string = Object.keys(app.get('bundles'))[0];
    const stackLen = app._router.stack.length;

    // force expiration
    process.env.DATAFILES_FILE = 'test/multishas/multishas3.data.json';
    app.get('bundleCache')[sha]['expiration'] = 0;
    await chai.request(srv).post('/reload');

    should.equal(app.get('bundles')[sha], undefined);
    should.equal(app.get('bundleCache')[sha], undefined);
    stackLen.should.equal(app._router.stack.length);
  });

  it('access via sha2', async () => {
    const sha: string = Object.keys(app.get('bundles'))[0];
    const resp = await gql(srv, query2, sha);
    resp.should.have.status(200);
    resp.body.data.resources_v1[0].name.should.equal('sha2');
    resp.body.data.resources_v1[0].resourceAField.should.equal('sha2');
    resp.body.data.resources_v1[0].newfield.should.equal('sha2');
  });

  it('access via sha3', async () => {
    const sha: string = Object.keys(app.get('bundles'))[1];
    const resp = await gql(srv, query2, sha);
    resp.should.have.status(200);
    resp.body.data.resources_v1[0].name.should.equal('sha3');
    resp.body.data.resources_v1[0].resourceAField.should.equal('sha3');
    resp.body.data.resources_v1[0].newfield.should.equal('sha3');
  });

});
