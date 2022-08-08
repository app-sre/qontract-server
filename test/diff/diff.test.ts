import * as http from 'http';

import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');
chai.use(chaiHttp);

import * as server from '../../src/server';
import * as db from '../../src/db';
import { logger } from '../../src/logger';

const should = chai.should();

const diskBundles = 'fs://test/diff/old.data.json,fs://test/diff/new.data.json';
const oldSha = 'bf56095bf2ada36a6b2deca9cb9b6616d536b5c9ce230f0905296165d221a66b';
const newSha = '302071115aa5dda8559f6e582fa7b6db7e0b64b5a9a6a9e3e9c22e2f86567f4b';

describe('diff', async() => {
  let srv: http.Server;
  before(async() => {
    process.env.INIT_BUNDLES = diskBundles;
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 4000 });
  });

  it('GET /sha256 returns a valid sha256', async () => {
    const response = await chai.request(srv).get('/sha256');
    return response.text.should.equal(newSha);
  });

  it('serve diff', async() => {
    const resp = await chai.request(srv)
                           .get(`/diff/${oldSha}/${newSha}`);
    resp.should.have.status(200);
    logger.info(JSON.stringify(resp.body));

    const changed = resp.body.datafiles['/cluster.yml'];
    changed.datafilepath.should.equal('/cluster.yml');
    changed.datafileschema.should.equal('/openshift/cluster-1.yml');

    const resource = resp.body.resources['/changed_resource.yml'];
    resource.resourcepath.should.equal('/changed_resource.yml');
  });

  after(() => {
    delete process.env.INIT_BUNDLES;
  });
});
