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
  res.body.should.have.all.keys('data', 'extensions');
};

describe('server', async () => {
  // Setup and teardown the GraphQL HTTP server.
  let srv: http.Server;
  before(async () => {
    process.env.LOAD_METHOD = 'fs';
    process.env.DATAFILES_FILE = 'test/server.data.json';
    const app = await server.appFromBundle(db.getInitialBundles());
    srv = app.listen({ port: 4000 });
  });
  after(async () => await util.promisify(srv.close));

  it('GET /sha256 returns a valid sha256', async () => {
    const response = await chai.request(srv).get('/sha256');
    return response.text.length.should.equal(64);
  });

  it('GET /git-commit-info returns commit information', async () => {
    const response = await chai.request(srv).get('/git-commit-info');
    response.body.commit.should.equal('cf639ded4b97808ffae8bfd4dc3f4c183508e1ca');
    response.body.timestamp.should.equal('1606295532');
    return response.should.have.status(200);
  });

  it('GET /git-commit-info/:sha returns commit information from sha', async () => {
    const shaResponse = await chai.request(srv).get('/sha256');
    const commitResponse = await chai.request(srv).get(`/git-commit-info/${shaResponse.text}`);
    commitResponse.body.commit.should.equal('cf639ded4b97808ffae8bfd4dc3f4c183508e1ca');
    commitResponse.body.timestamp.should.equal('1606295532');
    return commitResponse.should.have.status(200);
  });

  it('GET /git-commit-info/:sha returns 404 on unknown sha', async () => {
    const response = await chai.request(srv).get('/git-commit-info/LOL');
    return response.should.have.status(404);
  });

  it('resolves item refs', async () => {
    const query = `{
          roles: roles_v1 {
              name
              permissions {
                  service
              }
          }
        }`;

    const response = await chai.request(srv)
                            .post('/graphql')
                            .set('content-type', 'application/json')
                            .send({ query });
    responseIsNotAnError(response);

    response.body.extensions.schemas.should.eql(['/access/role-1.yml', '/access/permission-1.yml']);
    return response.body.data.roles[0].permissions[0].service.should.equal('github-org-team');
  });

  it('resolves object refs', async () => {
    const query = `{
          apps: apps_v1 {
              quayRepos {
                  org {
                      name
                  }
              }
          }
      }`;

    const response = await chai.request(srv)
                            .post('/graphql')
                            .set('content-type', 'application/json')
                            .send({ query });
    responseIsNotAnError(response);
    return response.body.data.apps[0].quayRepos[0].org.name.should.equal('quay-org-A');
  });

  it('can retrieve a resource', async () => {
    const query = `{
          resources: resources_v1(path: "/resource1.yml") {
            content
            sha256sum
            path
          }
      }`;

    const response = await chai.request(srv)
                            .post('/graphql')
                            .set('content-type', 'application/json')
                            .send({ query });
    responseIsNotAnError(response);
    response.body.data.resources.length.should.equal(1);
    return response.body.data.resources[0].content.should.equal('test resource');
  });

  it('can retrieve a resource with a non-empty schema', async () => {
    const query = `{
          resources: resources_v1(path: "/prometheus-resource.yml") {
            content
            sha256sum
            path
            schema
          }
      }`;

    const response = await chai.request(srv)
                            .post('/graphql')
                            .set('content-type', 'application/json')
                            .send({ query });
    responseIsNotAnError(response);
    response.body.data.resources.length.should.equal(1);
    return response.body.data.resources[0].schema.should.equal('/openshift/prometheus-rule-1.yml');
  });

  it('can search a resource by schema', async () => {
    const query = `{
          resources: resources_v1(schema: "/openshift/prometheus-rule-1.yml") {
            content
            sha256sum
            path
            schema
          }
      }`;

    const response = await chai.request(srv)
                            .post('/graphql')
                            .set('content-type', 'application/json')
                            .send({ query });
    responseIsNotAnError(response);
    response.body.data.resources.length.should.equal(1);
    return response.body.data.resources[0].path.should.equal('/prometheus-resource.yml');
  });

  it('can retrieve all resources', async () => {
    const query = `{
          resources: resources_v1 {
            content
            sha256sum
            path
            schema
          }
      }`;

    const response = await chai.request(srv)
                            .post('/graphql')
                            .set('content-type', 'application/json')
                            .send({ query });
    responseIsNotAnError(response);
    return response.body.data.resources.length.should.equal(2);
  });

  it('can search by path', async () => {
    const query = `{
      roles_v1(path: "/role-A.yml") {
        path
        name
      }
    }`;

    const response = await chai.request(srv)
                            .post('/graphql')
                            .set('content-type', 'application/json')
                            .send({ query });
    responseIsNotAnError(response);
    return response.body.data.roles_v1[0].name.should.equal('role-A');
  });

  it('can search by name (isSearchable)', async () => {
    const query = `{
      roles_v1(name: "role-B") {
        path
        name
      }
    }`;

    const response = await chai.request(srv)
                            .post('/graphql')
                            .set('content-type', 'application/json')
                            .send({ query });
    responseIsNotAnError(response);
    response.body.data.roles_v1.length.should.equal(1);
    return response.body.data.roles_v1[0].path.should.equal('/role-B.yml');
  });

  it('can search by name (isSearchable) with null to ignore filter', async () => {
    const query = `{
      roles_v1(name: null) {
        path
        name
      }
    }`;

    const response = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    responseIsNotAnError(response);
    return response.body.data.roles_v1.length.should.equal(2);
  });

  it('cannot search by name (NOT isSearchable)', async () => {
    const query = `{
      quay_orgs_v1(name:"quay-org-A") {
        path
        name
      }
    }`;

    const response = await chai.request(srv)
                            .post('/graphql')
                            .set('content-type', 'application/json')
                            .send({ query });

    return response.should.not.have.status(200);
  });

  it('can retrieve a field from an interface', async () => {
    const query = `{
      roles: roles_v1(path: "/role-A.yml") {
        permissions {
          service
          ... on PermissionGithubOrgTeam_v1 {
            org
          }
        }
      }
    }
    `;

    const response1 = await chai.request(srv).post('/graphql').set('content-type', 'application/json').send({ query });
    responseIsNotAnError(response1);
    response1.body.extensions.schemas.should.eql(['/access/role-1.yml',
      '/access/permission-1.yml']);
    response1.body.data.roles[0].permissions[0].org.should.equal('org-A');

    // check that it continues to work after a reload
    await chai.request(srv).post('/reload');

    const response2 = await chai.request(srv).post('/graphql').set('content-type', 'application/json').send({ query });
    responseIsNotAnError(response2);

    response2.body.extensions.schemas.should.eql(['/access/role-1.yml',
      '/access/permission-1.yml']);

    console.log(JSON.stringify(response2.body.data));

    const perm = response2.body.data.roles[0].permissions[0];
    expect(perm.org).to.equal('org-A');
  });
});

describe('bundle loading', async() => {

  it('check if init disk bundle is loaded', async() => {
    process.env.INIT_BUNDLES = 'fs://test/schemas/schemas.data.json';
    const app = await server.appFromBundle(db.getInitialBundles());
    const srv = app.listen({ port: 4000 });
    const resp = await chai.request(srv)
                        .get('/sha256');
    resp.should.have.status(200);
    return resp.text.should.eql('242acb1998e9d37c26186ba9be0262fb34e3ef388b503390d143164f7658c24e');
  });

  after(() => {
    delete process.env.INIT_BUNDLES;
  });
});
