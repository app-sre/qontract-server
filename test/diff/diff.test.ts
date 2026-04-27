import * as http from 'http';

import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');

import * as server from '../../src/server';
import * as db from '../../src/db';

chai.use(chaiHttp);
chai.should();

const diskBundles = 'fs://test/diff/old.data.json,fs://test/diff/new.data.json';
const oldSha = 'c1571df5261ca8ad3344a93c474e325f8cd5628df14f20569d12b22f467b81fb';
const newSha = '66d95c6b4a8c49317b9be0765190d0f487651d0e305e3062374124f79d955c2e';

describe('diff', async () => {
  let srv: http.Server;
  before(async () => {
    process.env.INIT_BUNDLES = diskBundles;
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 4000 });
  });

  it('GET /sha256 returns a valid sha256', async () => {
    const response = await chai.request(srv).get('/sha256');
    response.text.should.equal(newSha);
  });

  it('serve full diff', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/${newSha}`);
    resp.should.have.status(200);

    const changed = resp.body.datafiles['/cluster.yml'];
    changed.datafilepath.should.equal('/cluster.yml');
    changed.datafileschema.should.equal('/openshift/cluster-1.yml');

    const resource = resp.body.resources['/changed_resource.yml'];
    resource.resourcepath.should.equal('/changed_resource.yml');
  });

  it('serve full diff with identical changes', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/${oldSha}`);
    resp.should.have.status(200);
    const expectedBody = {
      datafiles: {},
      resources: {},
    };
    resp.body.should.deep.equal(expectedBody);
  });

  it('serve full diff with unknown old sha', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/unknown/${newSha}`);
    resp.should.have.status(404);
  });

  it('serve full diff with unknown new sha', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/unknown`);
    resp.should.have.status(404);
  });

  it('serve single datafile diff', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/${newSha}/datafile/cluster.yml`);
    resp.should.have.status(200);

    resp.body.datafilepath.should.equal('/cluster.yml');
    resp.body.datafileschema.should.equal('/openshift/cluster-1.yml');
    resp.body.old.automationToken.path.should.equals('secret-old');
    resp.body.new.automationToken.path.should.equals('secret-new');
  });

  it('serve single datafile diff with multi-segment path', async () => {
    // Express 5 (path-to-regexp v8) returns wildcard segments as string[]; verify they are
    // joined back with '/' so multi-segment paths resolve correctly (regression for /*rest)
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/${newSha}/datafile/services/app-interface/app.yml`);
    resp.should.have.status(200);
    resp.body.datafilepath.should.equal('/services/app-interface/app.yml');
  });

  it('serve single datafile diff missing', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/${newSha}/datafile/does_not_exit.yml`);
    resp.should.have.status(404);
  });

  it('serve single resourcefile diff', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/${newSha}/resourcefile/changed_resource.yml`);
    resp.should.have.status(200);

    resp.body.resourcepath.should.equal('/changed_resource.yml');
  });

  it('serve single resourcefile diff not found', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/${newSha}/resourcefile/does_not_exist.yml`);
    resp.should.have.status(404);
  });

  it('serve single diff unknown file type', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/${newSha}/unknown_file_type/does_not_exist.yml`);
    resp.should.have.status(400);
  });

  it('serve single diff with unknown old sha', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/unknown/${newSha}/datafile/cluster.yml`);
    resp.should.have.status(404);
  });

  it('serve single diff with unknown new sha', async () => {
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/unknown/datafile/cluster.yml`);
    resp.should.have.status(404);
  });

  it('serve single datafile diff without trailing filepath matches route', async () => {
    // {/*rest} makes the wildcard optional in Express 5 (same behaviour as /*? in Express 4)
    const resp = await chai.request(srv)
      .get(`/diff/${oldSha}/${newSha}/datafile`);
    resp.should.have.status(404);
    resp.text.should.equal('datafile not found');
  });

  after(() => {
    delete process.env.INIT_BUNDLES;
  });
});
