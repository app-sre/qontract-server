// Child-process fixture exercises real process signals without stopping Mocha.
const { appFromBundle, startHttpServer } = require('../../src/server');
const { bundleFromDisk } = require('../../src/db');
(async () => {
  const app = await appFromBundle([bundleFromDisk('test/server.data.json')]);
  const sha = app.get('latestBundleSha');
  const field = app.get('objectTypes')[sha].Query.getFields().roles_v1;
  const resolver = field.resolve;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  field.resolve = async (...args) => {
    process.send({ queryStarted: true });
    await gate;
    return resolver(...args);
  };
  process.on('message', (message) => {
    if (message === 'release') release();
  });
  const server = startHttpServer(app, 0);
  server.once('listening', () => {
    const listeners = ['SIGINT', 'SIGTERM'].map((signal) =>
      process.listenerCount(signal),
    );
    // Observe shutdown only after measuring the production handlers.
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => process.send({ signalReceived: signal }));
    }
    process.send({ port: server.address().port, listeners });
  });
  server.once('close', () => process.disconnect());
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
