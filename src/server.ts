import { ApolloServer } from 'apollo-server-express';
import * as express from 'express';

import * as db from './db';
import { generateAppSchema, defaultResolver } from './schema';

import promClient = require('prom-client');
const promBundle = require('express-prom-bundle');

interface IAcct {
  [key: string]: number;
}

interface ICacheInfo {
  expiration: number;
  serverMiddleware: express.Router;
}

// sha expiration time (in ms). Defaults to 1h.
const BUNDLE_SHA_TTL = Number(process.env.BUNDLE_SHA_TTL) || 20 * 60 * 1000;

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

// registers a new ApolloServer into the app router and cache
const registerApolloServer = (app: express.Express, bundleSha: string, server: any) => {
  const serverMiddleware = server.getMiddleware({ path: `/graphqlsha/${bundleSha}` });
  const expiration = Date.now() + BUNDLE_SHA_TTL;

  app.use(serverMiddleware);

  // add to the cache
  app.get('bundleCache')[bundleSha] = {
    serverMiddleware,
    expiration,
  } as ICacheInfo;

  // set as latest sha
  app.set('latestBundleSha', bundleSha);
};

// builds the ApolloServer for the specific bundleSha
const buildApolloServer = (app: express.Express, bundleSha: string): ApolloServer => {
  const schema = generateAppSchema(app, bundleSha);
  const server = new ApolloServer({
    schema,
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

  return server;
};

// remove expired bundles
const removeExpiredBundles = (app: express.Express) => {
  // remove expired bundles
  for (const [sha, cacheInfoObj] of Object.entries(app.get('bundleCache'))) {
    if (sha === app.get('latestBundleSha')) {
      continue;
    }

    const cacheInfo = cacheInfoObj as ICacheInfo;
    if (cacheInfo.expiration < Date.now()) {
      // removing sha
      console.log(`Removing expired bundle: ${sha}`);
      delete app.get('bundles')[sha];

      // remove from router. NOTE: this is not officially supported and may break in future
      // versions of express without warning.
      const index = app._router.stack.findIndex((m: any) =>
        m.handle === cacheInfo.serverMiddleware);
      app._router.stack.splice(index, 1);

      // remove from bundleCache
      delete app.get('bundleCache')[sha];
    }
  }
};

const updateCacheMetrics = (app: express.Express) => {
  routerStackGauge.set(app._router.stack.length);
  bundleGauge.set(Object.keys(app.get('bundles')).length);
  bundleCacheGauge.set(Object.keys(app.get('bundleCache')).length);
};

const updateResourceMetrics = (bundle: db.Bundle) => {
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

  // Register a middleware that sends /graphql to the latest bundle. This middleware also
  // increases the expiration time for a bundle.
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    // rewrite to graphqlsha/<sha>
    if (req.url === '/graphql') {
      const bundleSha = req.app.get('latestBundleSha');
      req.url = `/graphqlsha/${bundleSha}`;
    }

    const graphqlshaMatch = req.url.match(/\/graphqlsha\/(.*)$/);
    if (graphqlshaMatch) {
      const sha = graphqlshaMatch[1];
      if (app.get('bundleCache')[sha]) {
        app.get('bundleCache')[sha]['expiration'] = Date.now() + BUNDLE_SHA_TTL;
      }
    }

    next();
  });

  const server: ApolloServer = buildApolloServer(app, bundleSha);
  registerApolloServer(app, bundleSha, server);

  app.post('/reload', async (req: express.Request, res: express.Response) => {
    let bundle: db.Bundle;

    try {
      // fetch the new bundle
      bundle = await db.bundleFromEnvironment();
    } catch (e) {
      res.status(503).send('error parsing bundle, not replacing');
      return;
    }

    // store it in the `bundles` object
    const bundleSha = bundle.fileHash;

    if (app.get('bundles')[bundleSha]) {
      console.log('Skipping reload, data already loaded');
      res.send();
      return;
    }

    removeExpiredBundles(app);

    app.get('bundles')[bundleSha] = bundle;
    // register a new server exposing this bundle
    const server = buildApolloServer(app, bundleSha);
    registerApolloServer(app, bundleSha, server);

    updateResourceMetrics(bundle);
    updateCacheMetrics(app);

    console.log('reloaded');
    res.send();
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

  app.get('/cache', (req: express.Request, res: express.Response) => {
    const fullCacheInfo: any = { bundleCache: [] };

    for (const [sha, cacheInfoObj] of Object.entries(app.get('bundleCache'))) {
      const cacheInfo = cacheInfoObj as ICacheInfo;
      fullCacheInfo.bundleCache.push({ sha, expiration: cacheInfo.expiration });
    }

    fullCacheInfo['bundles'] = Object.keys(req.app.get('bundles'));
    fullCacheInfo['routerStack'] = app._router.stack.length;

    res.send(JSON.stringify(fullCacheInfo));
  });

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

    updateCacheMetrics(app);
    updateResourceMetrics(app.get('bundles')[app.get('latestBundleSha')]);
  });
}
