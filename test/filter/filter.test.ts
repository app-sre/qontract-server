import * as http from 'http';

import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');

import * as server from '../../src/server';
import * as db from '../../src/db';

chai.use(chaiHttp);
chai.should();

describe('pathobject', async () => {
  let srv: http.Server;
  before(async () => {
    process.env.LOAD_METHOD = 'fs';
    process.env.DATAFILES_FILE = 'test/filter/data.json';
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 4000 });
  });

  it('filter by searchable field', async () => {
    const query = `
      {
        test: resources_v1(name: "resource A") {
          path
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.data.test[0].name.should.equal('resource A');
  });

  it('filter by searchable field value list', async () => {
    const query = `
      {
        test: resources_v1(name__in__: ["resource A", "resource B"]) {
          path
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    new Set(resp.body.data.test.map((r: { name: string; }) => r.name)).should.deep.equal(new Set(['resource A', 'resource B']));
  });
});
