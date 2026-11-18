import { strict as assert } from 'assert';
import { fork } from 'child_process';
import * as http from 'http';
import { once } from 'events';
import * as path from 'path';

describe('process shutdown', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`drains a query and exits cleanly after ${signal}`, async function () {
      this.timeout(5000);
      const child = fork(path.join(__dirname, 'helpers/lifecycle-child.js'), {
        execArgv: ['-r', 'ts-node/register'],
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      try {
        const [ready] = await once(child, 'message');
        assert.deepEqual(ready.listeners, [1, 1]);
        const entered = once(child, 'message');
        const body = JSON.stringify({ query: '{ roles_v1 { name } }' });
        const response = new Promise<any>((resolve, reject) => {
          const request = http.request(
            {
              hostname: '127.0.0.1',
              port: ready.port,
              path: '/graphql',
              method: 'POST',
              agent: false,
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              },
            },
            (res) => {
              let text = '';
              res.on('data', (chunk) => {
                text += chunk;
              });
              res.on('end', () => resolve(JSON.parse(text)));
            },
          );
          request.on('error', reject);
          request.end(body);
        });
        await entered;
        const exited = once(child, 'exit');
        const signalled = once(child, 'message');
        child.kill(signal);
        const [notification] = await signalled;
        assert.equal(notification.signalReceived, signal);
        child.kill(signal); // Repeated termination must not interrupt the drain.
        child.send('release');
        const result = await response;
        assert.equal(result.errors, undefined);
        assert.equal(result.data.roles_v1[0].name, 'role-A');
        const [code, receivedSignal] = await exited;
        assert.equal(code, 0, stderr);
        assert.equal(receivedSignal, null, stderr);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }
    });
  }
});
