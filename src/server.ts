import 'dotenv/config';
import { ApolloServer } from 'apollo-server-express';
import * as express from 'express';

import promClient = require('prom-client');
import * as db from './db';
import * as metrics from './metrics';
import { defaultResolver, generateAppSchema } from './schema';
import { logger } from './logger';

const deepDiff = require('deep-diff');

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
  // eslint-disable-next-line no-param-reassign
  app.get('bundleCache')[bundleSha] = {
    serverMiddleware,
    expiration,
  } as ICacheInfo;

  // set as latest sha
  app.set('latestBundleSha', bundleSha);
};

const isEmptyObject = (obj: any): boolean => {
  if (obj === null || typeof obj !== 'object') {
    return false;
  }
  if (Array.isArray(obj)) {
    return false;
  }
  return Object.keys(obj).length === 0;
};

function excludeEmptyObjectInArray(data: any): any {
  if (data == null || typeof data !== 'object') {
    return data;
  }
  if (Array.isArray(data)) {
    return data
      .filter((i) => !isEmptyObject(i))
      .map((i) => excludeEmptyObjectInArray(i));
  }
  return Object.entries(data).reduce((acc: any, [key, value]) => {
    acc[key] = excludeEmptyObjectInArray(value);
    return acc;
  }, {});
}

const formatResponse = (response: any): any => excludeEmptyObjectInArray(response);

// builds the ApolloServer for the specific bundleSha
const buildApolloServer = (app: express.Express, bundleSha: string): ApolloServer => {
  const schema = generateAppSchema(app, bundleSha);
  const server = new ApolloServer({
    schema,
    playground: true,
    introspection: true,
    fieldResolver: defaultResolver(app, bundleSha),
    formatResponse,
    plugins: [
      {
        requestDidStart() {
          return {
            willSendResponse(requestContext) {
              // eslint-disable-next-line no-param-reassign
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
  // eslint-disable-next-line no-restricted-syntax
  for (const [sha, cacheInfoObj] of Object.entries(app.get('bundleCache'))) {
    if (sha === app.get('latestBundleSha')) {
      continue; // eslint-disable-line no-continue
    }

    const cacheInfo = cacheInfoObj as ICacheInfo;
    if (cacheInfo.expiration < Date.now()) {
      // removing sha
      logger.info('removing expired bundle: %s', sha);
      // eslint-disable-next-line no-param-reassign
      delete app.get('bundles')[sha];

      // remove from router. NOTE: this is not officially supported and may break in future
      // versions of express without warning.
      // eslint-disable-next-line no-underscore-dangle
      const index = app._router.stack.findIndex(
        (m: any) => m.handle === cacheInfo.serverMiddleware,
      );
      // eslint-disable-next-line no-underscore-dangle
      app._router.stack.splice(index, 1);

      // remove from bundleCache
      delete app.get('bundleCache')[sha]; // eslint-disable-line no-param-reassign

      // remove from searchableFields
      delete app.get('searchableFields')[sha]; // eslint-disable-line no-param-reassign

      // remove from datafileSchemas
      delete app.get('datafileSchemas')[sha]; // eslint-disable-line no-param-reassign

      // remove from objectTypes
      delete app.get('objectTypes')[sha]; // eslint-disable-line no-param-reassign

      // remove from objectInterfaces
      delete app.get('objectInterfaces')[sha]; // eslint-disable-line no-param-reassign
    }
  }
};

// Create application
export const appFromBundle = async (bundlePromises: Promise<db.Bundle>[]) => {
  const app: express.Express = express();

  // Create the initial `bundles` object. This object will have this shape:
  // bundles:
  //   <bundleSha>: <bundle>
  app.set('bundles', {});

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
        app.get('bundleCache')[sha].expiration = Date.now() + BUNDLE_SHA_TTL;
      }
    }

    next();
  });

  // eslint-disable-next-line no-restricted-syntax
  for (const bp of bundlePromises) {
    const bundle = await bp; // eslint-disable-line no-await-in-loop
    const sha = bundle.fileHash;
    app.get('bundles')[sha] = bundle;
    logger.info('loading initial bundle %s', sha);
    const server: ApolloServer = buildApolloServer(app, sha);
    registerApolloServer(app, sha, server);
  }

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

  app.get(
    '/diff/:base_sha/:head_sha/:filetype/*?',
    (req: express.Request, res: express.Response) => {
      const baseBundle: db.Bundle = req.app.get('bundles')[req.params.base_sha];
      if (baseBundle === undefined) {
        res.status(404).send(`Bundle ${req.params.base_sha} not found`);
        return;
      }
      const headBundle: db.Bundle = req.app.get('bundles')[req.params.head_sha];
      if (headBundle === undefined) {
        res.status(404).send(`Bundle ${req.params.head_sha} not found`);
        return;
      }

      const filepath = `/${req.params[0]}`;
      switch (req.params.filetype) {
        case 'datafile':
        {
          const oldRes = baseBundle.datafiles.get(filepath);
          const newRes = headBundle.datafiles.get(filepath);
          if (oldRes === undefined && newRes === undefined) {
            res.status(404).send('datafile not found');
          } else {
            res.send({
              datafilepath: filepath,
              datafileschema: (newRes !== undefined ? newRes : oldRes).$schema,
              old: oldRes,
              new: newRes,
            });
          }
          break;
        }
        case 'resourcefile': {
          const oldRes = baseBundle.resourcefiles.get(filepath);
          const newRes = headBundle.resourcefiles.get(filepath);
          if (oldRes === undefined && newRes === undefined) {
            res.status(404).send('resourcefile not found');
          } else {
            res.send({
              resourcepath: filepath,
              old: oldRes,
              new: newRes,
            });
          }
          break;
        }
        default:
          res.status(400).send(`unknown filetype ${req.params.filetype}`);
      }
    },
  );

  app.get('/diff/:base_sha/:head_sha', (req: express.Request, res: express.Response) => {
    const baseBundle: db.Bundle = req.app.get('bundles')[req.params.base_sha];
    if (baseBundle === undefined) {
      res.status(404).send(`Bundle ${req.params.base_sha} not found`);
      return;
    }
    const headBundle: db.Bundle = req.app.get('bundles')[req.params.head_sha];
    if (headBundle === undefined) {
      res.status(404).send(`Bundle ${req.params.head_sha} not found`);
      return;
    }

    // deepDiff can only diff objects, Map is not supported
    const dataDiffs = deepDiff(
      Object.fromEntries(baseBundle.datafiles),
      Object.fromEntries(headBundle.datafiles),
    );
    const resourceDiffs = deepDiff(
      Object.fromEntries(
        Array.from(baseBundle.resourcefiles, ([path, resource]) => [path, resource.sha256sum]),
      ),
      Object.fromEntries(
        Array.from(headBundle.resourcefiles, ([path, resource]) => [path, resource.sha256sum]),
      ),
    );

    const changes: any = {
      datafiles: {},
      resources: {},
    };

    (resourceDiffs || []).forEach((diff: any) => {
      const path = diff.path[0];
      const oldRes = baseBundle.resourcefiles.get(path);
      const newRes = headBundle.resourcefiles.get(path);
      changes.resources[path] = {
        resourcepath: path,
        old: oldRes,
        new: newRes,
      };
    });

    (dataDiffs || []).forEach((diff: any) => {
      const path = diff.path[0];
      const oldRes = baseBundle.datafiles.get(path);
      const newRes = headBundle.datafiles.get(path);
      changes.datafiles[path] = {
        datafilepath: path,
        datafileschema: (newRes !== undefined ? newRes : oldRes).$schema,
        old: oldRes,
        new: newRes,
      };
    });

    res.send(changes);
  });

  app.get('/git-commit', (req: express.Request, res: express.Response) => {
    const bundleSha = req.app.get('latestBundleSha');
    res.send(req.app.get('bundles')[bundleSha].gitCommit);
  });

  app.get('/git-commit/:sha', (req: express.Request, res: express.Response) => {
    const bundle = req.app.get('bundles')[req.params.sha];
    if (bundle === undefined) {
      res.status(404).send(`Bundle ${req.params.sha} not found`);
      return;
    }
    res.send(bundle.gitCommit);
  });

  app.get('/git-commit-info', (req: express.Request, res: express.Response) => {
    const bundleSha = req.app.get('latestBundleSha');
    const bundle = req.app.get('bundles')[bundleSha];
    const gitCommitInfo = {
      commit: bundle.gitCommit,
      timestamp: bundle.gitCommitTimestamp,
    };
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(gitCommitInfo));
  });

  app.get('/git-commit-info/:sha', (req: express.Request, res: express.Response) => {
    const bundle = req.app.get('bundles')[req.params.sha];
    if (bundle === undefined) {
      res.status(404).send(`Bundle ${req.params.sha} not found`);
      return;
    }
    const gitCommitInfo = {
      commit: bundle.gitCommit,
      timestamp: bundle.gitCommitTimestamp,
    };
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(gitCommitInfo));
  });

  app.get('/metrics', (req: express.Request, res: express.Response) => {
    res.send(promClient.register.metrics());
  });

  app.get('/cache', (req: express.Request, res: express.Response) => {
    const fullCacheInfo: any = { bundleCache: [] };

    // eslint-disable-next-line no-restricted-syntax
    for (const [sha, cacheInfoObj] of Object.entries(app.get('bundleCache'))) {
      const cacheInfo = cacheInfoObj as ICacheInfo;
      fullCacheInfo.bundleCache.push({ sha, expiration: cacheInfo.expiration });
    }

    fullCacheInfo.bundles = Object.keys(req.app.get('bundles'));
    // eslint-disable-next-line no-underscore-dangle
    fullCacheInfo.routerStack = app._router.stack.length;
    fullCacheInfo.searchableFields = Object.keys(req.app.get('searchableFields'));

    res.send(JSON.stringify(fullCacheInfo));
  });

  app.get('/healthz', (req: express.Request, res: express.Response) => { res.send(); });
  app.get('/', (req: express.Request, res: express.Response) => { res.redirect('/graphql'); });

  return app;
};

// If this is main, load an app from the environment and run the server.
if (!module.parent) {
  appFromBundle(db.getInitialBundles())
    .then((app) => {
      const server = app.listen({ port: 4000 }, () => {
        logger.info('Running at http://localhost:4000/graphql');
      });

      // eslint-disable-next-line no-restricted-syntax
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
          logger.info(`${signal} received, shutting down HTTP server`);
          server.close(() => {
            logger.info('HTTP server closed');
          });
        });
      }

      metrics.updateCacheMetrics(app);
      metrics.updateResourceMetrics(app.get('bundles')[app.get('latestBundleSha')]);
    });
}
