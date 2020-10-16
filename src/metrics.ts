import * as express from 'express';
import * as db from './db';

import promClient = require('prom-client');
const promBundle = require('express-prom-bundle');

interface IAcct {
  [key: string]: number;
}

// metrics middleware for express-prom-bundle
export const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  normalizePath: [
    ['^/graphqlsha/.*', '/graphqlsha/#sha'],
  ],
  buckets: [.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10],
  formatStatusCode: (res: express.Response) => `${Math.floor(res.statusCode / 100)}xx`,
});

// enable prom-client to expose default application metrics
promClient.collectDefaultMetrics({ prefix: 'qontract_server_' });
export promClient;

// Create metric stores
const reloadCounter = new promClient.Counter({
  name: 'qontract_server_reloads_total',
  help: 'Number of reloads for qontract server',
});

const datafilesGuage = new promClient.Gauge({
  name: 'qontract_server_datafiles',
  help: 'Number of datafiles for a specific schema',
  labelNames: ['schema'],
});

const routerStackGauge = new promClient.Gauge({
  name: 'qontract_server_router_stack',
  help: 'Number of layers in the router stack',
});

const bundleGauge = new promClient.Gauge({
  name: 'qontract_server_cache_bundle',
  help: 'Number of shas cached by the application in the bundle object',
});

const bundleCacheGauge = new promClient.Gauge({
  name: 'qontract_server_cache_bundle_cache',
  help: 'Number of shas cached by the application in the bundleCache object',
});

export const updateCacheMetrics = (app: express.Express) => {
  routerStackGauge.set(app._router.stack.length);
  bundleGauge.set(Object.keys(app.get('bundles')).length);
  bundleCacheGauge.set(Object.keys(app.get('bundleCache')).length);
};

export const updateResourceMetrics = (bundle: db.Bundle) => {
  // Count number of files for each schema type
  const reducer = (acc: IAcct, d: any) => {
    if (!(d.$schema in acc)) {
      acc[d.$schema] = 0;
    }
    acc[d.$schema] += 1;
    return acc;
  };
  const schemaCount: IAcct = bundle.datafiles.reduce(reducer, {});

  // Set the Guage based on counted metrics
  Object.keys(schemaCount).map(schemaName =>
    datafilesGuage.set({ schema: schemaName }, schemaCount[schemaName]),
  );

  reloadCounter.inc(1);
};
