import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import express = require('express');

import promClient = require('prom-client');
import * as db from './db';
import * as metrics from './metrics';
import { generateAppSchema } from './schema';
import { logger } from './logger';

const deepDiff = require('deep-diff');

// sha expiration time (in ms). Defaults to 20m.
const BUNDLE_SHA_TTL = Number(process.env.BUNDLE_SHA_TTL) || 20 * 60 * 1000;

interface IContext {
  schemas: string[];
}

// Interfaces
interface ICacheInfo {
  expiration: number;
}

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

// builds and starts the ApolloServer for the specific bundleSha
const buildApolloServer = async (
  app: express.Express,
  bundleSha: string,
): Promise<ApolloServer<IContext>> => {
  const schema = generateAppSchema(app, bundleSha);
  const server = new ApolloServer<IContext>({
    schema,
    introspection: true,
    // qontract-server is an internal API with no cookie-based auth, so CSRF protection
    // is not needed and would break existing GET-based clients (qontract-reconcile, etc.)
    csrfPrevention: false,
    plugins: [
      ApolloServerPluginLandingPageLocalDefault({ embed: true }),
      {
        async requestDidStart() {
          return {
            async willSendResponse(requestContext) {
              const { response, contextValue } = requestContext;
              if (response.body.kind === 'single') {
                response.body.singleResult.data = excludeEmptyObjectInArray(
                  response.body.singleResult.data,
                );
                response.body.singleResult.extensions = {
                  ...response.body.singleResult.extensions,
                  schemas: contextValue.schemas,
                };
              }
            },
          };
        },
      },
    ],
  });

  await server.start();
  return server;
};

// registers a new ApolloServer into the app router and cache
const registerApolloServer = (
  app: express.Express,
  bundleSha: string,
  server: ApolloServer<IContext>,
) => {
  const middleware = expressMiddleware(server, {
    context: async (): Promise<IContext> => ({ schemas: [] }),
  });
  const expiration = Date.now() + BUNDLE_SHA_TTL;

  app.get('shaRouters').set(bundleSha, middleware);

  // add to the cache

  app.get('bundleCache')[bundleSha] = {
    expiration,
  } as ICacheInfo;

  // set as latest sha
  app.set('latestBundleSha', bundleSha);
};

// remove expired bundles
const removeExpiredBundles = (app: express.Express) => {
  for (const [sha, cacheInfoObj] of Object.entries(app.get('bundleCache'))) {
    if (sha === app.get('latestBundleSha')) {
      continue;
    }

    const cacheInfo = cacheInfoObj as ICacheInfo;
    if (cacheInfo.expiration < Date.now()) {
      logger.info('removing expired bundle: %s', sha);

      delete app.get('bundles')[sha];

      // remove from shaRouters map
      app.get('shaRouters').delete(sha);

      // remove from bundleCache
      delete app.get('bundleCache')[sha];

      // remove from searchableFields
      delete app.get('searchableFields')[sha];

      // remove from datafileSchemas
      delete app.get('datafileSchemas')[sha];

      // remove from objectTypes
      delete app.get('objectTypes')[sha];

      // remove from objectInterfaces
      delete app.get('objectInterfaces')[sha];
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

  // Per-SHA router map: sha -> Apollo expressMiddleware
  app.set('shaRouters', new Map<string, express.Router>());

  // Middleware for prom metrics
  app.use(metrics.metricsMiddleware);

  // Register a middleware that will 503 if we haven't loaded a Bundle yet.
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (
        !['/', '/reload'].includes(req.url) &&
        typeof req.app.get('bundles') === 'undefined'
      ) {
        res.status(503).send('No loaded data.');
        return;
      }
      next();
    },
  );

  // Register a middleware that sends /graphql to the latest bundle. This middleware also
  // increases the expiration time for a bundle.
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      // rewrite to graphqlsha/<sha>, preserving any query string (needed for GET requests)
      if (req.path === '/graphql') {
        const bundleSha = req.app.get('latestBundleSha');
        const qs = req.url.includes('?')
          ? req.url.substring(req.url.indexOf('?'))
          : '';
        req.url = `/graphqlsha/${bundleSha}${qs}`;
      }

      const graphqlshaMatch = req.url.match(/\/graphqlsha\/(.*)$/);
      if (graphqlshaMatch) {
        const sha = graphqlshaMatch[1];
        if (app.get('bundleCache')[sha]) {
          app.get('bundleCache')[sha].expiration = Date.now() + BUNDLE_SHA_TTL;
        }
      }

      next();
    },
  );

  app.use(express.json());
  // expressMiddleware (Apollo v4) requires a parsed JSON body.
  // In Express 5, express.json() does not set req.body for GET requests (no body to parse),
  // but Apollo v4 rejects requests where req.body is undefined. Default to {} so GET queries work.
  app.use(
    ['/graphql', '/graphqlsha'],
    (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      if (req.body === undefined) {
        Object.assign(req, { body: {} });
      }
      next();
    },
  );

  // Single dispatcher for all /graphqlsha/:sha requests — routes to the correct Apollo middleware.
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const match = req.url.match(/^\/graphqlsha\/([^/?]+)/);
      if (match) {
        const sha = match[1];
        const handler = app.get('shaRouters').get(sha);
        if (handler) {
          handler(req, res, next);
          return;
        }
      }
      next();
    },
  );

  for (const bp of bundlePromises) {
    const bundle = await bp;
    const sha = bundle.fileHash;
    app.get('bundles')[sha] = bundle;
    logger.info('loading initial bundle %s', sha);
    const server = await buildApolloServer(app, sha);
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
    const server = await buildApolloServer(app, bundleSha);
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
    '/diff/:base_sha/:head_sha/:filetype{/*rest}',
    (req: express.Request, res: express.Response) => {
      const params = req.params as Record<string, string>;
      const { base_sha: baseSha, head_sha: headSha, filetype } = params;
      // Express 5 (path-to-regexp v8) returns wildcard segments as a string[]
      const restParam = req.params.rest as string | string[] | undefined;
      const restPath = Array.isArray(restParam)
        ? restParam.join('/')
        : (restParam ?? '');
      const baseBundle: db.Bundle = req.app.get('bundles')[baseSha];
      if (baseBundle === undefined) {
        res.status(404).send(`Bundle ${baseSha} not found`);
        return;
      }
      const headBundle: db.Bundle = req.app.get('bundles')[headSha];
      if (headBundle === undefined) {
        res.status(404).send(`Bundle ${headSha} not found`);
        return;
      }

      const filepath = `/${restPath}`;
      switch (filetype) {
        case 'datafile': {
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
          res.status(400).send(`unknown filetype ${filetype}`);
      }
    },
  );

  app.get(
    '/diff/:base_sha/:head_sha',
    (req: express.Request, res: express.Response) => {
      const { base_sha: baseSha, head_sha: headSha } = req.params as Record<
        string,
        string
      >;
      const baseBundle: db.Bundle = req.app.get('bundles')[baseSha];
      if (baseBundle === undefined) {
        res.status(404).send(`Bundle ${baseSha} not found`);
        return;
      }
      const headBundle: db.Bundle = req.app.get('bundles')[headSha];
      if (headBundle === undefined) {
        res.status(404).send(`Bundle ${headSha} not found`);
        return;
      }

      // deepDiff can only diff objects, Map is not supported
      const dataDiffs = deepDiff(
        Object.fromEntries(baseBundle.datafiles),
        Object.fromEntries(headBundle.datafiles),
      );
      const resourceDiffs = deepDiff(
        Object.fromEntries(
          Array.from(baseBundle.resourcefiles, ([path, resource]) => [
            path,
            resource.sha256sum,
          ]),
        ),
        Object.fromEntries(
          Array.from(headBundle.resourcefiles, ([path, resource]) => [
            path,
            resource.sha256sum,
          ]),
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
    },
  );

  app.get('/git-commit', (req: express.Request, res: express.Response) => {
    const bundleSha = req.app.get('latestBundleSha');
    res.send(req.app.get('bundles')[bundleSha].gitCommit);
  });

  app.get('/git-commit/:sha', (req: express.Request, res: express.Response) => {
    const { sha } = req.params as Record<string, string>;
    const bundle = req.app.get('bundles')[sha];
    if (bundle === undefined) {
      res.status(404).send(`Bundle ${sha} not found`);
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

  app.get(
    '/git-commit-info/:sha',
    (req: express.Request, res: express.Response) => {
      const { sha } = req.params as Record<string, string>;
      const bundle = req.app.get('bundles')[sha];
      if (bundle === undefined) {
        res.status(404).send(`Bundle ${sha} not found`);
        return;
      }
      const gitCommitInfo = {
        commit: bundle.gitCommit,
        timestamp: bundle.gitCommitTimestamp,
      };
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(gitCommitInfo));
    },
  );

  app.get('/metrics', async (req: express.Request, res: express.Response) => {
    res.send(await promClient.register.metrics());
  });

  app.get('/cache', (req: express.Request, res: express.Response) => {
    const fullCacheInfo: any = { bundleCache: [] };

    for (const [sha, cacheInfoObj] of Object.entries(app.get('bundleCache'))) {
      const cacheInfo = cacheInfoObj as ICacheInfo;
      fullCacheInfo.bundleCache.push({ sha, expiration: cacheInfo.expiration });
    }

    fullCacheInfo.bundles = Object.keys(req.app.get('bundles'));
    fullCacheInfo.routerStack = app.get('shaRouters').size;
    fullCacheInfo.searchableFields = Object.keys(
      req.app.get('searchableFields'),
    );

    res.send(JSON.stringify(fullCacheInfo));
  });

  app.get('/healthz', (req: express.Request, res: express.Response) => {
    res.send();
  });
  app.get('/', (req: express.Request, res: express.Response) => {
    res.redirect('/graphql');
  });

  return app;
};

// If this is main, load an app from the environment and run the server.
if (require.main === module) {
  appFromBundle(db.getInitialBundles()).then((app) => {
    const server = app.listen({ port: 4000 }, () => {
      logger.info('Running at http://localhost:4000/graphql');
    });

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        logger.info(`${signal} received, shutting down HTTP server`);
        server.close(() => {
          logger.info('HTTP server closed');
        });
      });
    }

    metrics.updateCacheMetrics(app);
    metrics.updateResourceMetrics(
      app.get('bundles')[app.get('latestBundleSha')],
    );
  });
}
