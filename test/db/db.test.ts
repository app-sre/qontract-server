import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as chai from 'chai';

import * as db from '../../src/db';

chai.should();

const emptyBundle = JSON.stringify({ data: {}, graphql: [], resources: {} });

describe('bundleFromDisk DATAFILES_WAIT_TIMEOUT_SECONDS', () => {
  let tmpDir: string;
  let bundlePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qontract-server-test-'));
    bundlePath = path.join(tmpDir, 'data.json');
    delete process.env.DATAFILES_WAIT_TIMEOUT_SECONDS;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATAFILES_WAIT_TIMEOUT_SECONDS;
  });

  it('without the env var, waits up to the default 1s then fails', async function () {
    this.timeout(5000);
    const start = Date.now();
    try {
      await db.bundleFromDisk(bundlePath);
      chai.assert.fail('expected bundleFromDisk to reject');
    } catch (err) {
      (err as Error).message.should.match(/Timed out after 1s waiting for/);
    }
    (Date.now() - start).should.be.at.least(900);
  });

  it('set to 0, fails immediately instead of waiting', async () => {
    process.env.DATAFILES_WAIT_TIMEOUT_SECONDS = '0';
    const start = Date.now();
    try {
      await db.bundleFromDisk(bundlePath);
      chai.assert.fail('expected bundleFromDisk to reject');
    } catch (err) {
      (err as NodeJS.ErrnoException).code.should.equal('ENOENT');
    }
    (Date.now() - start).should.be.below(500);
  });

  it('with the env var, waits for the file to appear and then loads it', async function () {
    this.timeout(5000);
    process.env.DATAFILES_WAIT_TIMEOUT_SECONDS = '5';
    setTimeout(() => fs.writeFileSync(bundlePath, emptyBundle), 300);

    const bundle = await db.bundleFromDisk(bundlePath);
    bundle.datafiles.size.should.equal(0);
  });

  it('with the env var, waits for a partially written bundle to complete before loading', async function () {
    this.timeout(5000);
    process.env.DATAFILES_WAIT_TIMEOUT_SECONDS = '5';
    fs.writeFileSync(bundlePath, emptyBundle.slice(0, 10));
    setTimeout(() => fs.appendFileSync(bundlePath, emptyBundle.slice(10)), 300);

    const bundle = await db.bundleFromDisk(bundlePath);
    bundle.datafiles.size.should.equal(0);
  });

  it('with the env var, times out if the file never appears', async function () {
    this.timeout(5000);
    process.env.DATAFILES_WAIT_TIMEOUT_SECONDS = '1';
    try {
      await db.bundleFromDisk(bundlePath);
      chai.assert.fail('expected bundleFromDisk to reject');
    } catch (err) {
      (err as Error).message.should.match(/Timed out after 1s waiting for/);
    }
  });
});

describe('bundleFromDisk default path', () => {
  beforeEach(() => {
    delete process.env.DATAFILES_FILE;
    process.env.DATAFILES_WAIT_TIMEOUT_SECONDS = '0';
  });

  afterEach(() => {
    delete process.env.DATAFILES_WAIT_TIMEOUT_SECONDS;
  });

  it('defaults to /bundle/bundle.json when DATAFILES_FILE is unset', async () => {
    try {
      await db.bundleFromDisk(undefined);
      chai.assert.fail('expected bundleFromDisk to reject');
    } catch (err) {
      (err as NodeJS.ErrnoException).path.should.equal('/bundle/bundle.json');
    }
  });
});
