import * as fs from 'fs';
import * as express from 'express';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import * as chai from 'chai';

// Chai is bad with types. See:
// https://github.com/DefinitelyTyped/DefinitelyTyped/issues/19480
import chaiHttp = require('chai-http');

import * as server from '../../src/server';
import * as db from '../../src/db';

chai.use(chaiHttp);
const should = chai.should();

describe('bundle TTL refresh', () => {
  let srv: http.Server;
  let app: express.Express;
  let temporaryDirectory: string;
  let previousLoadMethod: string | undefined;
  let previousDatafilesFile: string | undefined;

  const query = '{ resources_v1 { name } }';

  before(async () => {
    previousLoadMethod = process.env.LOAD_METHOD;
    previousDatafilesFile = process.env.DATAFILES_FILE;
    process.env.LOAD_METHOD = 'fs';

    app = await server.appFromBundle([
      db.bundleFromDisk('test/multishas/multishas1.data.json'),
      db.bundleFromDisk('test/multishas/multishas2.data.json'),
      db.bundleFromDisk('test/multishas/multishas3.data.json'),
    ]);

    srv = app.listen({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      srv.once('listening', resolve);
      srv.once('error', reject);
    });
  });

  after(async () => {
    try {
      if (srv?.listening) {
        await new Promise<void>((resolve, reject) => {
          srv.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (temporaryDirectory) {
        await fs.promises.rm(temporaryDirectory, {
          recursive: true,
          force: true,
        });
      }
    } finally {
      if (typeof previousLoadMethod === 'undefined') {
        delete process.env.LOAD_METHOD;
      } else {
        process.env.LOAD_METHOD = previousLoadMethod;
      }
      if (typeof previousDatafilesFile === 'undefined') {
        delete process.env.DATAFILES_FILE;
      } else {
        process.env.DATAFILES_FILE = previousDatafilesFile;
      }
    }
  });

  it('refreshes queried bundles and removes only expired historical bundles', async () => {
    const [refreshedSha, untouchedSha, latestSha] = Object.keys(
      app.get('bundles'),
    );
    const cache = app.get('bundleCache');
    cache[refreshedSha].expiration = 0;

    const historicalGet = await chai
      .request(srv)
      .get(`/graphqlsha/${refreshedSha}`)
      .query({ query });
    historicalGet.should.have.status(200);
    historicalGet.body.data.resources_v1[0].name.should.equal('sha1');
    cache[refreshedSha].expiration.should.be.greaterThan(0);

    cache[latestSha].expiration = 0;
    const latestGet = await chai.request(srv).get('/graphql').query({ query });
    latestGet.should.have.status(200);
    latestGet.body.data.resources_v1[0].name.should.equal('sha3');
    cache[latestSha].expiration.should.be.greaterThan(0);

    cache[latestSha].expiration = 0;
    const post = await chai
      .request(srv)
      .post(`/graphqlsha/${latestSha}`)
      .send({ query });
    post.should.have.status(200);
    cache[latestSha].expiration.should.be.greaterThan(0);

    cache[untouchedSha].expiration = 0;
    temporaryDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'qontract-server-ttl-'),
    );
    const bundleData = JSON.parse(
      await fs.promises.readFile('test/multishas/multishas3.data.json', 'utf8'),
    );
    bundleData.data['/resource1.yml'].name = 'sha4';
    bundleData.data['/resource1.yml'].newfield = 'sha4';
    bundleData.data['/resource1.yml'].resourceAField = 'sha4';
    const nextBundlePath = path.join(temporaryDirectory, 'multishas4.json');
    await fs.promises.writeFile(nextBundlePath, JSON.stringify(bundleData));
    process.env.DATAFILES_FILE = nextBundlePath;

    const reload = await chai.request(srv).post('/reload');
    reload.should.have.status(200);
    should.exist(app.get('bundles')[refreshedSha]);
    should.not.exist(app.get('bundles')[untouchedSha]);
  });
});
