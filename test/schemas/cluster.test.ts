import * as server from '../../src/server';
import * as db from '../../src/db';

// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import * as chai from 'chai';
import chaiHttp = require('chai-http');
chai.use(chaiHttp);
const should = chai.should();

describe('clusters', () => {
  before(() => {
    db.loadFromFile('test/schemas/cluster.data.json');
  });

  it('serves a basic graphql query', (done) => {
    chai.request(server)
      .get('/graphql')
      .query({ query: '{ clusters { name } }' })
      .end((err, res) => {
        res.should.have.status(200);
        res.body.data.clusters[0].name.should.equal('example cluster');
        done();
      });
  });
});
