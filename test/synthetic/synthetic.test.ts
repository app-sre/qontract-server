import * as http from 'http';

import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');
chai.use(chaiHttp);

import * as server from '../../src/server';
import * as db from '../../src/db';

const should = chai.should();

describe('synthetic', async() => {
  let srv: http.Server;
  before(async() => {
    process.env.LOAD_METHOD = 'fs';
    process.env.DATAFILES_FILE = 'test/synthetic/data.json';
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 4000 });
  });

  it('resolves synthetics', async() => {
    const query = `
      {
        test: cakerecipe_v1(path: "/recipes/guillaumes-deluxe.yml") {
          name
          recipeCollections {
            name
          }
        }
      }
      `;
    const resp = await chai.request(srv)
                        .post('/graphql')
                        .set('content-type', 'application/json')
                        .send({ query });
    resp.should.have.status(200);
    resp.body.data.test[0].name.should.equal('Guillaumes Delux');
    return resp.body.data.test[0].recipeCollections[0].name.should.equal('Magical Cakes');
  });

  it('resolves nested synthetics with lists as leaf elements', async() => {
    const query = `
      {
        test: ingredient_v1(path: "/ingredients/pixiedust.yml") {
          name
          recipes {
            name
          }
        }
      }
      `;
    const resp = await chai.request(srv)
                        .post('/graphql')
                        .set('content-type', 'application/json')
                        .send({ query });
    resp.should.have.status(200);
    resp.body.data.test[0].name.should.equal('Pixiedust');
    return resp.body.data.test[0].recipes[0].name.should.equal('Guillaumes Delux');
  });

  it('resolves nested synthetics with an object as leaf element', async() => {
    const query = `
      {
        test: store_v1(path: "/stores/magical-ingredients-inc.yml") {
          name
          shoppingLists {
            name
          }
        }
      }
      `;
    const resp = await chai.request(srv)
                        .post('/graphql')
                        .set('content-type', 'application/json')
                        .send({ query });
    resp.should.have.status(200);
    resp.body.data.test[0].name.should.equal('Magical Ingredients Inc.');
    return resp.body.data.test[0].shoppingLists[0].name.should.equal('Birthday Party');
  });
});
