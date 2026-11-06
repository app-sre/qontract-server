import * as chai from 'chai';
import * as http from 'http';
import chaiHttp = require('chai-http');
import { appFromBundle } from '../../src/server';
import { bundleFromDisk } from '../../src/db';
import * as db from '../../src/db';
import { ApolloServer } from '@apollo/server';
import { shutdownHttpServer } from '../../src/apolloLifecycle';

chai.use(chaiHttp);
const { expect } = chai;

const deferred = () => {
  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve() };
};

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for bundle retirement');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe('Apollo bundle lifecycle', () => {
  let client: ChaiHttp.Agent;
  let app: Awaited<ReturnType<typeof appFromBundle>>;
  let previousLoadMethod: string | undefined;
  let previousDatafilesFile: string | undefined;
  beforeEach(() => {
    app = undefined;
    client = undefined;
    previousLoadMethod = process.env.LOAD_METHOD;
    previousDatafilesFile = process.env.DATAFILES_FILE;
    process.env.LOAD_METHOD = 'fs';
  });
  afterEach(async () => {
    if (client)
      await new Promise<void>((resolve) => client.close(() => resolve()));
    if (app) await app.get('apolloLifecycle').stopAll();
    for (const [key, value] of [
      ['LOAD_METHOD', previousLoadMethod],
      ['DATAFILES_FILE', previousDatafilesFile],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('does not add per-bundle process signal listeners across reloads', async () => {
    const before = ['SIGINT', 'SIGTERM'].map((signal) =>
      process.listenerCount(signal),
    );
    app = await appFromBundle([
      bundleFromDisk('test/multishas/multishas1.data.json'),
    ]);
    client = chai.request(app).keepOpen();
    for (const file of ['multishas2.data.json', 'multishas3.data.json']) {
      process.env.DATAFILES_FILE = `test/multishas/${file}`;
      expect(await client.post('/reload')).to.have.status(200);
    }
    expect(
      ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
    ).to.deep.equal(before);
  });

  it('keeps an expired bundle alive until its active query finishes', async () => {
    const originalBundle = await bundleFromDisk('test/server.data.json');
    const sha = originalBundle.fileHash;
    app = await appFromBundle([
      Promise.resolve(originalBundle),
      bundleFromDisk('test/multishas/multishas1.data.json'),
    ]);
    const field = app.get('objectTypes')[sha].Query.getFields().roles_v1;
    const originalResolver = field.resolve;
    const entered = deferred();
    const release = deferred();
    field.resolve = async (...args: any[]) => {
      entered.resolve();
      await release.promise;
      return originalResolver(...args);
    };
    client = chai.request(app).keepOpen();
    const response = client
      .post(`/graphqlsha/${sha}`)
      .send({ query: '{ roles_v1 { name } }' })
      .then((result) => result);
    try {
      await entered.promise;
      app.get('bundleCache')[sha].expiration = 0;
      process.env.DATAFILES_FILE = 'test/multishas/multishas2.data.json';
      expect(await client.post('/reload')).to.have.status(200);
      expect(app.get('bundles')[sha]).not.eq(undefined);
      expect(
        await client
          .post(`/graphqlsha/${sha}`)
          .timeout({ response: 500 })
          .send({ query: '{ roles_v1 { name } }' }),
      ).to.have.status(404);
    } finally {
      release.resolve();
    }
    const result = await response;
    expect(result).to.have.status(200);
    expect(result.body.errors).eq(undefined);
    expect(result.body.data.roles_v1).to.deep.equal([
      { name: 'role-A' },
      { name: 'role-B' },
    ]);
    await waitFor(() => app.get('bundles')[sha] === undefined);
    expect(app.get('shaRouters').has(sha)).eq(false);
  });
  it('keeps bundle state until execution finishes after a client disconnects', async () => {
    const originalBundle = await bundleFromDisk('test/server.data.json');
    const sha = originalBundle.fileHash;
    app = await appFromBundle([
      Promise.resolve(originalBundle),
      bundleFromDisk('test/multishas/multishas1.data.json'),
    ]);
    const field = app.get('objectTypes')[sha].Query.getFields().roles_v1;
    const resolver = field.resolve;
    const entered = deferred();
    const release = deferred();
    field.resolve = async (...args: any[]) => {
      entered.resolve();
      await release.promise;
      return resolver(...args);
    };
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    client = chai.request(server).keepOpen();
    const body = JSON.stringify({ query: '{ roles_v1 { name } }' });
    const request = http.request({
      hostname: '127.0.0.1',
      port: (server.address() as { port: number }).port,
      path: `/graphqlsha/${sha}`,
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    });
    request.on('error', () => {}); // Disconnect is intentional.
    const closed = new Promise<void>((resolve) =>
      request.once('close', resolve),
    );
    request.end(body);
    try {
      await entered.promise;
      request.destroy();
      await closed;
      app.get('bundleCache')[sha].expiration = 0;
      process.env.DATAFILES_FILE = 'test/multishas/multishas2.data.json';
      expect(await client.post('/reload')).to.have.status(200);
      expect(app.get('bundles')[sha]).not.eq(undefined);
    } finally {
      release.resolve();
      request.destroy();
    }
    await waitFor(() => app.get('bundles')[sha] === undefined);
  });
  it('waits for a disconnected reload and stops its newly registered server', async () => {
    const started: ApolloServer[] = [];
    const originalStart = ApolloServer.prototype.start;
    const originalLoad = db.bundleFromEnvironment;
    const entered = deferred();
    const release = deferred();
    ApolloServer.prototype.start = async function () {
      await originalStart.call(this);
      started.push(this);
    };
    let request: http.ClientRequest;
    let shutdown: Promise<void>;
    try {
      app = await appFromBundle([bundleFromDisk('test/server.data.json')]);
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      client = chai.request(server).keepOpen();
      process.env.DATAFILES_FILE = 'test/multishas/multishas2.data.json';
      (db as any).bundleFromEnvironment = async () => {
        entered.resolve();
        await release.promise;
        return originalLoad();
      };
      request = http.request({
        hostname: '127.0.0.1',
        port: (server.address() as { port: number }).port,
        path: '/reload',
        method: 'POST',
        agent: false,
      });
      request.on('error', () => {});
      const closed = new Promise<void>((resolve) =>
        request.once('close', resolve),
      );
      request.end();
      await entered.promise;
      request.destroy();
      await closed;
      let finished = false;
      shutdown = shutdownHttpServer(server, app.get('apolloLifecycle')).then(
        () => {
          finished = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).eq(false);
      release.resolve();
      await shutdown;
      // Both the original and late, successfully started candidate must be stopped.
      expect(started).to.have.length(2);
      for (const server of started)
        expect(() => server.assertStarted('expressMiddleware()')).to.throw();
    } finally {
      release.resolve();
      request?.destroy();
      if (shutdown) await shutdown;
      (db as any).bundleFromEnvironment = originalLoad;
      ApolloServer.prototype.start = originalStart;
    }
  });
  it('stops already started instances if a later initial bundle is invalid', async () => {
    const bundle = await bundleFromDisk('test/server.data.json');
    const started: ApolloServer[] = [];
    const originalStart = ApolloServer.prototype.start;
    ApolloServer.prototype.start = async function () {
      await originalStart.call(this);
      started.push(this);
    };
    try {
      let error: Error;
      try {
        await appFromBundle([
          Promise.resolve(bundle),
          Promise.resolve({
            ...bundle,
            fileHash: 'invalid-schema',
            schema: [],
          }),
        ]);
      } catch (failure) {
        error = failure as Error;
      }
      expect(error).to.be.instanceOf(Error);
      expect(started).to.have.length(1);
      expect(() => started[0].assertStarted('expressMiddleware()')).to.throw();
    } finally {
      ApolloServer.prototype.start = originalStart;
    }
  });
});
