import { strict as assert } from 'assert';
import * as http from 'http';
import { ApolloServer } from '@apollo/server';
import { ApolloLifecycle, shutdownHttpServer } from '../src/apolloLifecycle';

const deferred = () => {
  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve() };
};

const makeServer = async (onStop: () => void | Promise<void> = () => {}) => {
  const server = new ApolloServer({
    typeDefs: 'type Query { value: Int }',
    resolvers: { Query: { value: () => 7 } },
    stopOnTerminationSignals: false,
    plugins: [
      {
        async serverWillStart() {
          return {
            async serverWillStop() {
              await onStop();
            },
          };
        },
      },
    ],
  });
  await server.start();
  return server;
};

const listen = async (server: http.Server) => {
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return (server.address() as { port: number }).port;
};

describe('Apollo lifecycle ownership', () => {
  it('stops a retired server before releasing its bundle state, once requests finish', async () => {
    const lifecycle = new ApolloLifecycle();
    const server = await makeServer();
    let cleanups = 0;
    lifecycle.add('old', server, () => {
      assert.throws(
        () => server.assertStarted('expressMiddleware()'),
        /start|stop/,
      );
      cleanups++;
    });
    const release = lifecycle.acquire('old');
    assert.ok(release);
    const retirement = lifecycle.retire('old');
    assert.equal(lifecycle.acquire('old'), undefined);
    assert.equal(cleanups, 0);
    // Existing work can still use Apollo while its request lease is held.
    const result = await server.executeOperation({ query: '{ value }' });
    assert.equal(result.body.kind, 'single');
    release();
    release(); // A request completion cannot decrement another request's lease.
    await retirement;
    await lifecycle.retire('old');
    assert.equal(cleanups, 1);
    assert.throws(
      () => server.assertStarted('expressMiddleware()'),
      /start|stop/,
    );
  });

  it('releases ownership across repeated retirement and reuse of a bundle SHA', async () => {
    const lifecycle = new ApolloLifecycle();
    let stopped = 0;
    let cleaned = 0;
    const listeners = ['SIGINT', 'SIGTERM'].map((signal) =>
      process.listenerCount(signal),
    );
    for (let i = 0; i < 30; i++) {
      const server = await makeServer(() => {
        stopped++;
      });
      lifecycle.add('reloaded', server, () => {
        cleaned++;
      });
      await lifecycle.retire('reloaded');
    }
    await lifecycle.stopAll();
    assert.equal(stopped, 30);
    assert.equal(cleaned, 30);
    assert.deepEqual(
      ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
      listeners,
    );
  });

  it('attempts all stops even when one server fails to stop', async () => {
    const lifecycle = new ApolloLifecycle();
    const broken = await makeServer(() => {
      throw new Error('stop failed');
    });
    const healthy = await makeServer();
    let removed = 0;
    lifecycle.add('broken', broken, () => {
      throw new Error('must not discard failed stop');
    });
    lifecycle.add('healthy', healthy, () => {
      removed++;
    });
    await assert.rejects(() => lifecycle.stopAll(), /stop failed/);
    assert.equal(removed, 1);
    assert.equal(lifecycle.acquire('broken'), undefined);
    assert.throws(
      () => healthy.assertStarted('expressMiddleware()'),
      /start|stop/,
    );
    assert.throws(
      () => lifecycle.add('late', healthy, () => {}),
      /shutting down/,
    );
  });

  it('waits for HTTP requests before stopping Apollo', async () => {
    const lifecycle = new ApolloLifecycle();
    const apollo = await makeServer();
    lifecycle.add('current', apollo, () => {});
    const entered = deferred();
    const release = deferred();
    const server = http.createServer(async (_req, res) => {
      entered.resolve();
      await release.promise;
      res.end('complete');
    });
    const port = await listen(server);
    const response = new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/`, { agent: false }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve(body));
        })
        .on('error', reject);
    });
    await entered.promise;
    const shutdown = shutdownHttpServer(server, lifecycle);
    try {
      apollo.assertStarted('expressMiddleware()');
      assert.equal(server.listening, false);
    } finally {
      release.resolve();
    }
    assert.equal(await response, 'complete');
    await shutdown;
    assert.throws(
      () => apollo.assertStarted('expressMiddleware()'),
      /start|stop/,
    );
  });

  it('bounds shutdown when an Apollo stop never completes', async () => {
    const lifecycle = new ApolloLifecycle();
    const release = deferred();
    const apollo = await makeServer(() => release.promise);
    lifecycle.add('current', apollo, () => {});
    const server = http.createServer();
    await listen(server);
    try {
      await assert.rejects(
        () => shutdownHttpServer(server, lifecycle, 30),
        /Timed out/,
      );
    } finally {
      release.resolve();
      await lifecycle.stopAll();
    }
  });

  it('bounds shutdown while a disconnected bundle load is still running', async () => {
    const lifecycle = new ApolloLifecycle();
    const release = deferred();
    let apollo: ApolloServer;
    const load = lifecycle.trackLoad(async (own) => {
      await release.promise;
      apollo = await makeServer();
      own('late', apollo, () => {});
    });
    const server = http.createServer();
    await listen(server);
    try {
      await assert.rejects(
        () => shutdownHttpServer(server, lifecycle, 30),
        /Timed out/,
      );
    } finally {
      release.resolve();
      await load;
      await lifecycle.stopAll();
    }
    assert.throws(
      () => apollo.assertStarted('expressMiddleware()'),
      /start|stop/,
    );
  });

  it('closes stuck HTTP connections when the shutdown deadline expires', async () => {
    const lifecycle = new ApolloLifecycle();
    const entered = deferred();
    const server = http.createServer(() => {
      entered.resolve();
    });
    const port = await listen(server);
    const closed = new Promise<void>((resolve) => {
      const request = http.get(`http://127.0.0.1:${port}/`);
      request.on('error', () => {});
      request.once('close', resolve);
    });
    await entered.promise;
    await assert.rejects(
      () => shutdownHttpServer(server, lifecycle, 30),
      /Timed out/,
    );
    await closed;
  });
});
