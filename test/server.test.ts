import * as server from '../src/server';
import * as db from '../src/db';

// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import * as chai from 'chai';
import chaiHttp = require('chai-http');
chai.use(chaiHttp);
const should = chai.should();

function validateGraphQLResponse(res: any) {
  res.should.have.status(200);
  res.body.should.not.have.any.keys('errors');
  res.body.should.have.all.keys('data');
}

describe('server', () => {
  before(() => {
    db.loadFromFile('test/server.data.json');
  });

  it('GET /sha256 returns a valid sha256', (done) => {
    chai.request(server)
          .get('/sha256')
          .end((err: any, res: any) => {
            res.text.length.should.equal(64);
            done();
          });
  });

  it('resolves item refs', (done) => {
    const query = `{
          role {
              name
              permissions {
                  service
              }
          }
        }`;

    chai.request(server)
      .get('/graphql')
      .query({ query })
      .end((err: any, res: any) => {
        validateGraphQLResponse(res);
        const permissionsName: any = res.body.data.role[0].permissions[0].service;
        permissionsName.should.equal('github-org-team');
        done();
      });
  });

  it('resolves object refs', (done) => {
    const query = `{
          app {
              quayRepos {
                  org {
                      name
                  }
              }
          }
      }`;

    chai.request(server)
      .get('/graphql')
      .query({ query })
      .end((err: any, res: any) => {
        validateGraphQLResponse(res);
        const orgResponse = res.body.data.app[0].quayRepos[0].org.name;
        orgResponse.should.equal('quay-org-A');
        done();
      });
  });
});
