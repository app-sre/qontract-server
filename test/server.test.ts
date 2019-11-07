import * as http from 'http';
import * as util from 'util';

import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');
chai.use(chaiHttp);

import * as server from '../src/server';
import * as db from '../src/db';

const should = chai.should();
const expect = chai.expect;

const responseIsNotAnError = (res: any) => {
  res.should.have.status(200);
  res.body.should.not.have.any.keys('errors');
  res.body.should.have.all.keys('data');
};

describe('server', async() => {
  // Setup and teardown the GraphQL HTTP server.
  let srv: http.Server;
  before(async() => {
    const app = await server.appFromBundle(db.bundleFromDisk('test/server.data.json'));
    srv = app.listen({ port: 4000 });
  });
  after(async() => await util.promisify(srv.close));

  it('GET /sha256 returns a valid sha256', async() => {
    const response = await chai.request(srv).get('/sha256');
    return response.text.length.should.equal(64);
  });

  it('resolves item refs', async() => {
    const query = `{
          roles: roles_v1 {
              name
              permissions {
                  service
              }
          }
        }`;

    const sha_response = await chai.request(srv).get('/sha256');
    const response = await chai.request(srv).get('/graphql/' + sha_response.text).query({ query });
    responseIsNotAnError(response);
    return response.body.data.roles[0].permissions[0].service.should.equal('github-org-team');
  });

  it('resolves object refs', async() => {
    const query = `{
          apps: apps_v1 {
              quayRepos {
                  org {
                      name
                  }
              }
          }
      }`;

    const sha_response = await chai.request(srv).get('/sha256');
    const response = await chai.request(srv).get('/graphql/' + sha_response.text).query({ query });
    responseIsNotAnError(response);
    return response.body.data.apps[0].quayRepos[0].org.name.should.equal('quay-org-A');
  });

  it('can retrieve a resource', async() => {
    const query = `{
          resources: resources_v1(path: "/resource1.yml") {
            content
            sha256sum
            path
          }
      }`;

    const sha_response = await chai.request(srv).get('/sha256');
    const response = await chai.request(srv).get('/graphql/' + sha_response.text).query({ query });
    responseIsNotAnError(response);
    return response.body.data.resources[0].content.should.equal('test resource');
  });
});
