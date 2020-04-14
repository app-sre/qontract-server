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
    const app = await server.appFromBundle(db.bundleFromDisk('test/schemas/cluster.data.json'));
    srv = app.listen({ port: 4000 });
  });

  it('serves a basic graphql query', async() => {
    const resp = await chai.request(srv).get('/graphql').query(
      { query: '{ clusters: clusters_v1 { name } }' },
    );
    resp.should.have.status(200);
    return resp.body.data.clusters[0].name.should.equal('example cluster');
  });
});
