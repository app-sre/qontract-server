import * as express from 'express';
import promClient = require('prom-client');
import * as db from './db';

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
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  formatStatusCode: (res: express.Response) => `${Math.floor(res.statusCode / 100)}xx`,
});

// enable prom-client to expose default application metrics
promClient.collectDefaultMetrics({ prefix: 'qontract_server_' });

// Create metric stores
const reloadCounter = new promClient.Counter({
  name: 'qontract_server_reloads_total',
  help: 'Number of reloads for qontract server',
});

const datafilesGauge = new promClient.Gauge({
  name: 'qontract_server_datafiles',
  help: 'Number of datafiles for a specific schema',
  labelNames: ['schema'],
});

const routerStackGauge = new promClient.Gauge({
  name: 'qontract_server_router_stack_layers',
  help: 'Number of layers in the router stack',
});

const bundleGauge = new promClient.Gauge({
  name: 'qontract_server_bundle_object_shas',
  help: 'Number of shas cached by the application in the bundle object',
});

const bundleCacheGauge = new promClient.Gauge({
  name: 'qontract_server_bundle_cache_object_shas',
  help: 'Number of shas cached by the application in the bundleCache object',
});

export const updateCacheMetrics = (app: express.Express) => {
  routerStackGauge.set(app._router.stack.length); // eslint-disable-line no-underscore-dangle
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

  // Set the Gauge based on counted metrics
  Object.keys(schemaCount)
    .map((schemaName) => datafilesGauge.set({ schema: schemaName }, schemaCount[schemaName]));

  reloadCounter.inc(1);
};
