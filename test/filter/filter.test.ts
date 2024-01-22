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

  it('searchable field - equals', async () => {
    const query = `
      {
        test: resources_v1(name: "resource A") {
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

  it('searchable field - null value', async () => {
    const query = `
      {
        test: resources_v1(name: null) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.data.test.length.should.equal(8);
  });

  it('filter object - field value eq', async () => {
    const query = `
      {
        test: resources_v1(filter: {name: "resource A"}) {
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

  it('filter object - unknown field', async () => {
    const query = `
      {
        test: resources_v1(filter: {unknown_field: "resource A"}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.errors[0].message.should.equal('Field "unknown_field" does not exist on type "Resource_v1"');
  });

  it('filter object - in (contains) condition', async () => {
    const query = `
      {
        test: resources_v1(filter: {name: {in: ["resource A", "resource B"]}}) {
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

  it('filter object - unknown field', async () => {
    const query = `
      {
        test: resources_v1(filter: {unknown_field: "value"}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.errors.length.should.equal(1);
  });

  it('filter object - null field value', async () => {
    const query = `
      {
        test: resources_v1(filter: {optional_field: null}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.data.test.length.should.equal(3);
    resp.body.data.test[0].name.should.equal('resource D');
  });

  it('filter object - non-null field value', async () => {
    const query = `
      {
        test: resources_v1(filter: {reference: { ne: null }}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.data.test.length.should.be.above(0);
    resp.body.data.test.forEach((r: { reference?: any; }) => {
      if (r.reference !== undefined && r.reference !== null) {
        throw new Error('reference should be undefined or null');
      }
    });
  });

  it('filter object - not-equal field value', async () => {
    const query = `
      {
        test: resources_v1(filter: {optional_field: { ne: "E" }}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.data.test.length.should.be.above(0);
    resp.body.data.test.forEach((r: { optional_field?: string; }) => {
      if (r.optional_field !== undefined && r.optional_field === 'E') {
        throw new Error('optional_field should not have value "E"');
      }
    });
  });

  it('filter object - list field eq', async () => {
    const query = `
      {
        test: resources_v1(filter: {list_field: ["A", "B", "C"]}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.body.data.test.length.should.equal(1);
    resp.body.data.test[0].name.should.equal('resource E');
  });

  it('filter object - null list field', async () => {
    const query = `
      {
        test: resources_v1(filter: {list_field: null}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    new Set(resp.body.data.test.map((r: { name: string; }) => r.name)).should.deep.equal(new Set(['resource A', 'resource B', 'resource C', 'resource D', 'resource G', 'resource H']));
  });

  it('filter object - referenced object - field value eq', async () => {
    const query = `
      {
        test: resources_v1(filter: {reference: {filter: {name: "resource A"}}}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.data.test.length.should.equal(1);
    resp.body.data.test[0].name.should.equal('resource G');
  });

  it('filter object - referenced object - unknown field', async () => {
    const query = `
      {
        test: resources_v1(filter: {reference: {filter: {unknown_field: "resource A"}}}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.errors[0].message.should.equal('Field "unknown_field" does not exist on type "Resource_v1"');
  });

  it('filter object - referenced object - field null', async () => {
    const query = `
      {
        test: resources_v1(filter: {reference: {filter: {optional_field: null}}}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.data.test.length.should.equal(1);
    resp.body.data.test[0].name.should.equal('resource H');
  });

  it('filter object - referenced object - list field in', async () => {
    const query = `
      {
        test: resources_v1(filter: {reference_list: {filter: {name: {in: ["resource A", "resource B", "resource C", "resource D"]}}}}) {
          name
        }
      }
      `;
    const resp = await chai.request(srv)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send({ query });
    resp.should.have.status(200);
    resp.body.data.test.length.should.equal(1);
    resp.body.data.test[0].name.should.equal('resource H');
  });
});
