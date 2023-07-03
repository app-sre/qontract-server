import * as http from 'http';

import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');

import * as server from '../../src/server';
import * as db from '../../src/db';

chai.use(chaiHttp);

describe('clusters', async () => {
  let srv: http.Server;
  before(async () => {
    process.env.LOAD_METHOD = 'fs';
    process.env.DATAFILES_FILE = 'test/resourceref/data.json';
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 4000 });
  });

  it('resolve resource refs', async () => {
    const query = `
      {
        test: test_type_v1 {
          name
          unresolvable_resource_ref
          resolvable_resource_ref {
            content
          }
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.extensions.schemas.should.eql(['/test-type-1.yml']);
    resp.body.data.test[0].name.should.equal('name');
    resp.body.data.test[0].unresolvable_resource_ref.should.equal('/resource1.yml');
    return resp.body.data.test[0].resolvable_resource_ref.content.should.equal('test resource');
  });
});
