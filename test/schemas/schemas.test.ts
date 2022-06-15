import * as http from 'http';

import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');
chai.use(chaiHttp);

import * as server from '../../src/server';
import * as db from '../../src/db';

const should = chai.should();

describe('clusters', async() => {
  let srv: http.Server;
  before(async() => {
    process.env.LOAD_METHOD = 'fs';
    process.env.DATAFILES_FILE = 'test/schemas/schemas.data.json';
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 4000 });
  });

  it('serves a basic graphql query', async() => {
    const query = '{ clusters: clusters_v1 { name } }';
    const resp = await chai.request(srv)
                        .post('/graphql')
                        .set('content-type', 'application/json')
                        .send({ query });
    resp.should.have.status(200);
    resp.body.extensions.schemas.should.eql(['/openshift/cluster-1.yml']);
    return resp.body.data.clusters[0].name.should.equal('example cluster');
  });
});

describe('clusters', async() => {
  let srv: http.Server;
  before(async() => {
    process.env.INIT_DISK_BUNDLES = 'test/schemas/schemas.data.json';
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 4000 });
  });

  it('check if init disk bundle loads the bundle', async() => {
    const resp = await chai.request(srv)
                        .get('/sha256');
    resp.should.have.status(200);
    return resp.text.should.eql('242acb1998e9d37c26186ba9be0262fb34e3ef388b503390d143164f7658c24e');
  });

  before(() => {
    delete process.env.INIT_DISK_BUNDLES;
  });
});
