import { ApolloServer } from 'apollo-server-express';
import * as express from 'express';
import promClient = require('prom-client');

import * as db from './db';
import * as metrics from './metrics';
import { generateAppSchema, defaultResolver } from './schema';
import { logger } from './logger';

// sha expiration time (in ms). Defaults to 20m.
const BUNDLE_SHA_TTL = Number(process.env.BUNDLE_SHA_TTL) || 20 * 60 * 1000;

// Interfaces
interface ICacheInfo {
  expiration: number;
  serverMiddleware: express.Router;
}

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
      logger.info('removing expired bundle: %s', sha);
      delete app.get('bundles')[sha];

      // remove from router. NOTE: this is not officially supported and may break in future
      // versions of express without warning.
      const index = app._router.stack.findIndex((m: any) =>
        m.handle === cacheInfo.serverMiddleware);
      app._router.stack.splice(index, 1);

      // remove from bundleCache
      delete app.get('bundleCache')[sha];

      // remove from searchableFields
      delete app.get('searchableFields')[sha];
    }
  }
};

// Create application
export const appFromBundle = async (bundlePromises: Promise<db.Bundle>[]) => {
  const app: express.Express = express();

  // Create the initial `bundles` object. This object will have this shape:
  // bundles:
  //   <bundleSha>: <bundle>
  const bundles: any = {};

  let bundleSha: string;
  for (const bp of bundlePromises) {
    const bundle = await bp;
    bundleSha = bundle.fileHash;
    bundles[bundleSha] = bundle;
    logger.info('loading initial bundle %s', bundleSha);
  }

  app.set('bundles', bundles);

  // Create cache object
  app.set('bundleCache', {});

  // Middleware for prom metrics
  app.use(metrics.metricsMiddleware);

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
    if (req.path === '/graphql') {
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
      logger.info('skipping reload, data already loaded');
      res.send();
      return;
    }

    removeExpiredBundles(app);

    app.get('bundles')[bundleSha] = bundle;
    // register a new server exposing this bundle
    const server = buildApolloServer(app, bundleSha);
    registerApolloServer(app, bundleSha, server);

    metrics.updateResourceMetrics(bundle);
    metrics.updateCacheMetrics(app);

    logger.info('bundle loaded: %s', bundleSha);
    res.send();
  });

  app.get('/sha256', (req: express.Request, res: express.Response) => {
    const bundleSha = req.app.get('latestBundleSha');
    logger.info('GET /sha256 requested. Replied with %s', bundleSha);
    res.send(req.app.get('bundles')[bundleSha].fileHash);
  });

  app.get('/git-commit', (req: express.Request, res: express.Response) => {
    const bundleSha = req.app.get('latestBundleSha');
    res.send(req.app.get('bundles')[bundleSha].gitCommit);
  });

  app.get('/git-commit/:sha', (req: express.Request, res: express.Response) => {
    res.send(req.app.get('bundles')[req.params.sha].gitCommit);
  });

  app.get('/git-commit-info', (req: express.Request, res: express.Response) => {
    const bundleSha = req.app.get('latestBundleSha');
    const gitCommitInfo: any = {};
    gitCommitInfo['commit'] = req.app.get('bundles')[bundleSha].gitCommit;
    gitCommitInfo['timestamp'] = req.app.get('bundles')[bundleSha].gitCommitTimestamp;
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(gitCommitInfo));
  });

  app.get('/git-commit-info/:sha', (req: express.Request, res: express.Response) => {
    const gitCommitInfo: any = {};

    if (!(req.params.sha in req.app.get('bundles'))) {
      res.status(404).send(`Bundle ${req.params.sha} not found`);
      return;
    }

    gitCommitInfo['commit'] = req.app.get('bundles')[req.params.sha].gitCommit;
    gitCommitInfo['timestamp'] = req.app.get('bundles')[req.params.sha].gitCommitTimestamp;
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(gitCommitInfo));
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
    fullCacheInfo['searchableFields'] = Object.keys(req.app.get('searchableFields'));

    res.send(JSON.stringify(fullCacheInfo));
  });

  app.get('/healthz', (req: express.Request, res: express.Response) => { res.send(); });
  app.get('/', (req: express.Request, res: express.Response) => { res.redirect('/graphql'); });

  return app;
};

// If this is main, load an app from the environment and run the server.
if (!module.parent) {
  const app = appFromBundle(db.getInitialBundles());

  app.then((app) => {
    app.listen({ port: 4000 }, () => {
      logger.info('Running at http://localhost:4000/graphql');
    });

    metrics.updateCacheMetrics(app);
    metrics.updateResourceMetrics(app.get('bundles')[app.get('latestBundleSha')]);
  });
}
