import * as util from 'util';
import * as fs from 'fs';

import { ApolloServer } from 'apollo-server-express';
import * as express from 'express';

import * as db from './db';
import { generateAppSchema, defaultResolver } from './schema';

import promClient = require('prom-client');
const promBundle = require('express-prom-bundle');

interface IAcct {
  [key: string]: number;
}

// sha expiration time (in ms)
const BUNDLE_SHA_TTL = 20 * 60 * 1000;

// metrics middleware for express-prom-bundle
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  normalizePath: [
    ['^/graphqlsha/.*', '/graphqlsha/#sha'],
  ],
  buckets: [.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10],
  formatStatusCode: (res: express.Response) => `${Math.floor(res.statusCode / 100)}xx`,
});

// enable prom-client to expose default application metrics
const collectDefaultMetrics = promClient.collectDefaultMetrics;

// Probe every 5th second.
collectDefaultMetrics({ prefix: 'qontract_server_' });

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

// registers a new ApolloServer into the app router and cache
const registerApolloServer = (app: express.Express, bundleSha: string, server: any) => {
  const serverMiddleware = server.getMiddleware({ path: `/graphqlsha/${bundleSha}` });
  const expiration = Date.now() + BUNDLE_SHA_TTL;

  app.use(serverMiddleware);

  // add to the cache
  app.get('bundleCache')[bundleSha] = {
    serverMiddleware,
    expiration,
  };

  // set as latest sha
  app.set('latestBundleSha', bundleSha);
};

// builds the ApolloServer for the specific bundleSha
const buildApolloServer = (app: express.Express, bundleSha: string): ApolloServer => new ApolloServer({
  schema: generateAppSchema(app, bundleSha),
  playground: true,
  introspection: true,
  fieldResolver: defaultResolver(app, bundleSha),
  plugins: [
    {
      requestDidStart(requestContext) {
        return {
          willSendResponse(requestContext) {
            requestContext.response.extensions = { schemas: requestContext.context.schemas };
          },
        };
      },
    },
  ],
});

export const appFromBundle = async (bundlePromise: Promise<db.Bundle>) => {
  const app: express.Express = express();

  // Create the initial `bundles` object. This object will have this shape:
  // bundles:
  //   <bundleSha>: <bundle>
  const bundle = await bundlePromise;
  const bundleSha = bundle.fileHash;
  const bundles: any = {};
  bundles[bundleSha] = bundle;
  app.set('bundles', bundles);

  // Create cache object
  app.set('bundleCache', {});

  // Middleware for prom metrics
  app.use(metricsMiddleware);

  // Register a middleware that will 503 if we haven't loaded a Bundle yet.
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((!['/', '/reload'].includes(req.url)) && typeof (req.app.get('bundles')) === 'undefined') {
      res.status(503).send('No loaded data.');
      return;
    }
    next();
  });

  // Register a middleware that sends /graphql to the latest bundle
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.url === '/graphql') {
      const bundleSha = req.app.get('latestBundleSha');
      req.url = `/graphqlsha/${bundleSha}`;
    }
    next();
  });

  const server: ApolloServer = buildApolloServer(app, bundleSha);
  registerApolloServer(app, bundleSha, server);

  app.post('/reload', async (req: express.Request, res: express.Response) => {
    try {
      // fetch the new bundle
      const bundle = await db.bundleFromEnvironment();

      // store it in the `bundles` object
      const bundleSha = bundle.fileHash;
      app.get('bundles')[bundleSha] = bundle;

      // register a new server exposing this bundle
      const server = buildApolloServer(app, bundleSha);
      registerApolloServer(app, bundleSha, server);

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

      console.log('reloaded');
      res.send();
    } catch (e) {
      res.status(503).send('error parsing bundle, not replacing');
    }
  });

  app.get('/sha256', (req: express.Request, res: express.Response) => {
    const bundleSha = req.app.get('latestBundleSha');
    res.send(req.app.get('bundles')[bundleSha].fileHash);
  });

  app.get('/git-commit', (req: express.Request, res: express.Response) => {
    const bundleSha = req.app.get('latestBundleSha');
    res.send(req.app.get('bundles')[bundleSha].gitCommit);
  });

  app.get('/git-commit/:sha', (req: express.Request, res: express.Response) => {
    res.send(req.app.get('bundles')[req.params.sha].gitCommit);
  });

  app.get('/metrics', (req: express.Request, res: express.Response) => {
    res.send(promClient.register.metrics());
  });

  app.get('/cache', (req: express.Request, res: express.Response) => { res.send(req.app.get('bundleCache')); });
  app.get('/healthz', (req: express.Request, res: express.Response) => { res.send(); });
  app.get('/', (req: express.Request, res: express.Response) => { res.redirect('/graphql'); });

  return app;
};

// If this is main, load an app from the environment and run the server.
if (!module.parent) {
  const app = appFromBundle(db.bundleFromEnvironment());

  app.then((app) => {
    app.listen({ port: 4000 }, () => {
      console.log('Running at http://localhost:4000/graphql');
    });
  });
}
