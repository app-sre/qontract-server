import * as http from 'http';

import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');
chai.use(chaiHttp);

import * as server from '../../src/server';
import * as db from '../../src/db';

const should = chai.should();

describe('pathobject', async() => {
  let srv: http.Server;
  before(async() => {
    process.env.LOAD_METHOD = 'fs';
    process.env.DATAFILES_FILE = 'test/pathobject/data.json';
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 4000 });
  });

  it('resolves pathobject', async() => {
    const query = `
      {
        test: recipecollection_v1(path: "/collections/magical-recipes.yml") {
          name
          recipes {
            path
            schema
            ... on CakeRecipe_v1 {
                inventor
            }
            ... on BeerRecipe_v1 {
                brewery
            }
          }
        }
      }
      `;
    const resp = await chai.request(srv)
                        .post('/graphql')
                        .set('content-type', 'application/json')
                        .send({ query });
    resp.should.have.status(200);
    resp.body.data.test[0].recipes[0].path.should.equal('/cakerecipe/guillaumes-deluxe.yml');
    resp.body.data.test[0].recipes[0].schema.should.equal('/cakerecipe-1.yml');
    resp.body.data.test[0].recipes[0].inventor.should.equal('Guillaume');
    resp.body.data.test[0].recipes[1].path.should.equal('/beerrecipe/unicorn-ale.yml');
    resp.body.data.test[0].recipes[1].schema.should.equal('/beerrecipe-1.yml');
    return resp.body.data.test[0].recipes[1].brewery.should.equal('Equestrias Finest');
  });
});
