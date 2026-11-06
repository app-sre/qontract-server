import * as http from 'http';
import * as chai from 'chai';
import chaiHttp = require('chai-http');
import promClient = require('prom-client');
import { appFromBundle } from '../src/server';
import { bundleFromDisk } from '../src/db';
import { graphqlOperationAllowlist } from '../src/metrics';

chai.use(chaiHttp);
const { expect } = chai;

const metricNames = {
  total: 'qontract_server_graphql_operation_duration_seconds',
  execution: 'qontract_server_graphql_execution_duration_seconds',
  postprocess: 'qontract_server_graphql_postprocess_duration_seconds',
};

// Read the public exposition, not the implementation's metric objects.
const samples = (text: string, name: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`))
    .map((line) => {
      const labels: Record<string, string> = {};
      for (const match of line.matchAll(/(\w+)="([^"]*)"/g)) {
        labels[match[1]] = match[2];
      }
      return { labels, value: Number(line.slice(line.lastIndexOf(' ') + 1)) };
    });

const count = (text: string, name: string, labels: Record<string, string>) =>
  samples(text, `${name}_count`)
    .filter((sample) =>
      Object.entries(labels).every(
        ([key, value]) => sample.labels[key] === value,
      ),
    )
    .reduce((sum, sample) => sum + sample.value, 0);

describe('GraphQL operation metrics', () => {
  let srv: http.Server;
  let client: ChaiHttp.Agent;
  let previousOperations: string | undefined;
  before(async () => {
    previousOperations = process.env.GRAPHQL_METRICS_OPERATIONS;
    process.env.GRAPHQL_METRICS_OPERATIONS = 'Rolebindings,Users';
    const app = await appFromBundle([bundleFromDisk('test/server.data.json')]);
    srv = app.listen(0);
    client = chai.request(srv).keepOpen();
  });
  after(async () => {
    if (previousOperations === undefined) {
      delete process.env.GRAPHQL_METRICS_OPERATIONS;
    } else {
      process.env.GRAPHQL_METRICS_OPERATIONS = previousOperations;
    }
    await new Promise<void>((resolve, reject) =>
      client.close((error) => (error ? reject(error) : resolve())),
    );
  });
  beforeEach(() => {
    for (const name of Object.values(metricNames)) {
      promClient.register.getSingleMetric(name)?.reset();
    }
  });

  const query = (source: string, operationName?: string) =>
    client.post('/graphql').send({ query: source, operationName });
  const scrape = async () => (await client.get('/metrics')).text;

  it('exports one observation per phase without changing the response', async () => {
    // Repetition also exercises Apollo's parsed-document cache.
    for (let i = 0; i < 2; i++) {
      const response = await query('query Rolebindings { roles_v1 { name } }');
      expect(response).to.have.status(200);
      expect(response.body).to.deep.equal({
        data: { roles_v1: [{ name: 'role-A' }, { name: 'role-B' }] },
        extensions: { schemas: ['/access/role-1.yml'] },
      });
    }
    const text = await scrape();
    const labels = { operation: 'Rolebindings', root_field: 'roles_v1' };
    expect(
      count(text, metricNames.total, { ...labels, outcome: 'success' }),
    ).eq(2);
    expect(count(text, metricNames.execution, labels)).eq(2);
    expect(
      count(text, metricNames.postprocess, { operation: 'Rolebindings' }),
    ).eq(2);
    const totalSeconds = samples(text, `${metricNames.total}_sum`)[0].value;
    for (const name of Object.values(metricNames)) {
      expect(samples(text, `${name}_sum`)[0].value).at.most(totalSeconds);
      expect(samples(text, `${name}_sum`)[0].value).greaterThan(0);
      const buckets = samples(text, `${name}_bucket`);
      expect(buckets.find((sample) => sample.labels.le === '+Inf')?.value).eq(
        2,
      );
    }
  });

  it('does not expose arbitrary operation names or aliases as labels', async () => {
    for (let i = 0; i < 20; i++) {
      await query(
        `query PrivateName${i} { privateAlias${i}: roles_v1 { name } }`,
      );
    }
    const text = await scrape();
    expect(
      count(text, metricNames.total, {
        operation: 'other',
        root_field: 'roles_v1',
        outcome: 'success',
      }),
    ).eq(20);
    expect(text).not.to.match(/PrivateName\d|privateAlias\d/);
    expect(samples(text, `${metricNames.total}_count`)).to.have.length(1);
  });

  it('uses the selected operation and follows root fragments without visiting nested fields', async () => {
    await query(
      `
      query Ignored { apps_v1 { title } }
      query Users { ...Root ... on Query { alias: roles_v1 { name } } }
      fragment Root on Query { roles_v1 { permissions { service } } }
    `,
      'Users',
    );
    expect(
      count(await scrape(), metricNames.total, {
        operation: 'Users',
        root_field: 'roles_v1',
        outcome: 'success',
      }),
    ).eq(1);
  });

  it('groups multi-root operations instead of attributing the full duration to each root', async () => {
    await query('{ roles_v1 { name } apps_v1 { title } }');
    const text = await scrape();
    expect(
      count(text, metricNames.total, {
        operation: 'anonymous',
        root_field: 'multiple',
        outcome: 'success',
      }),
    ).eq(1);
    expect(samples(text, `${metricNames.total}_count`)).to.have.length(1);
  });

  it('records invalid requests once without claiming they executed', async () => {
    await query('query SecretParse {');
    await query('query SecretValidation { secretUnknownField }');
    const text = await scrape();
    expect(
      count(text, metricNames.total, {
        operation: 'invalid',
        root_field: 'none',
        outcome: 'error',
      }),
    ).eq(2);
    expect(samples(text, `${metricNames.execution}_count`)).to.have.length(0);
    expect(text).not.to.match(
      /SecretParse|SecretValidation|secretUnknownField/,
    );
  });

  it('preserves operation-selection errors without recording execution', async () => {
    for (const operationName of [undefined, 'UnknownOperation']) {
      const response = await query(
        'query First { roles_v1 { name } } query Second { apps_v1 { title } }',
        operationName,
      );
      expect(response).to.have.status(400);
      expect(response.body.errors[0].extensions.code).eq(
        'OPERATION_RESOLUTION_FAILURE',
      );
    }
    const text = await scrape();
    expect(
      count(text, metricNames.total, {
        operation: 'invalid',
        root_field: 'none',
        outcome: 'error',
      }),
    ).eq(2);
    expect(samples(text, `${metricNames.execution}_count`)).to.have.length(0);
  });

  it('records execution failures and excludes errors from the success distribution', async () => {
    await query(
      'query Rolebindings($show: Boolean!) { roles_v1 @include(if: $show) { name } }',
    );
    const text = await scrape();
    expect(
      count(text, metricNames.total, {
        operation: 'Rolebindings',
        root_field: 'roles_v1',
        outcome: 'error',
      }),
    ).eq(1);
    expect(
      count(text, metricNames.execution, { operation: 'Rolebindings' }),
    ).eq(1);
  });

  it('records resolver errors with partial data once in each applicable phase', async () => {
    const bundle = await bundleFromDisk('test/server.data.json');
    Object.assign(bundle.datafiles.get('/role-A.yml'), {
      name: {}, // GraphQL cannot serialize this as a String.
    });
    const app = await appFromBundle([Promise.resolve(bundle)]);
    const response = await chai.request(app).post('/graphql').send({
      query: 'query Rolebindings { roles_v1 { name } apps_v1 { title } }',
    });
    expect(response).to.have.status(200);
    expect(response.body.errors).to.have.length(1);
    expect(response.body.data.roles_v1).eq(null);
    expect(response.body.data.apps_v1).to.deep.equal([{ title: 'app-A' }]);
    const text = await scrape();
    expect(
      count(text, metricNames.total, {
        operation: 'Rolebindings',
        root_field: 'multiple',
        outcome: 'error',
      }),
    ).eq(1);
    expect(
      count(text, metricNames.execution, { operation: 'Rolebindings' }),
    ).eq(1);
    expect(
      count(text, metricNames.postprocess, { operation: 'Rolebindings' }),
    ).eq(1);
  });

  it('shares metric registration across bundle servers', async () => {
    const app = await appFromBundle([
      bundleFromDisk('test/server.data.json'),
      bundleFromDisk('test/diff/old.data.json'),
    ]);
    const response = await chai.request(app).get('/metrics');
    expect(response).to.have.status(200);
    expect(
      response.text.match(new RegExp(`# HELP ${metricNames.total} `, 'g')),
    ).to.have.length(1);
    expect(response.text).to.include(
      'qontract_server_nodejs_eventloop_lag_p99_seconds',
    );
  });
});

describe('GraphQL metrics operation allowlist', () => {
  it('rejects invalid/oversized names and bounds client-controlled label cardinality', () => {
    const configured = [
      ' Rolebindings ',
      'Users',
      'Users',
      'not-valid',
      'x'.repeat(129),
      ...Array.from({ length: 100 }, (_, i) => `Query${i}`),
    ].join(',');
    const allowed = graphqlOperationAllowlist(configured);
    expect(allowed.has('Rolebindings')).eq(true);
    expect(allowed.has('Users')).eq(true);
    expect(allowed.has('not-valid')).eq(false);
    expect(allowed.has('x'.repeat(129))).eq(false);
    expect(allowed.size).at.most(50);
    expect(graphqlOperationAllowlist('')).to.have.property('size', 0);
  });
});
