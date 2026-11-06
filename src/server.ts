import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { ApolloServerPluginCacheControlDisabled } from '@apollo/server/plugin/disabled';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import express = require('express');
import {
  ApolloLifecycle,
  RegisterApollo,
  shutdownHttpServer,
} from './apolloLifecycle';

import promClient = require('prom-client');
import * as db from './db';
import * as metrics from './metrics';
import { generateAppSchema } from './schema';
import { logger } from './logger';

import microdiff from 'microdiff';

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
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return false;
    }
  }
  return true;
};

// Strips empty `{}` elements from arrays (produced when GraphQL inline fragments
// do not match an interface implementation's concrete type) in a single pass
// while returning new arrays and objects so the input is never mutated.
export function excludeEmptyObjectInArray(data: any): any {
  if (data === null || typeof data !== 'object') {
    return data;
  }
  if (Array.isArray(data)) {
    const result = [];
    for (const item of data) {
      if (!isEmptyObject(item)) {
        result.push(excludeEmptyObjectInArray(item));
      }
    }
    return result;
  }
  const result: Record<string, any> = {};
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      result[key] = excludeEmptyObjectInArray(data[key]);
    }
  }
  return result;
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
    stopOnTerminationSignals: false,
    // qontract-server is an internal API with no cookie-based auth, so CSRF protection
    // is not needed and would break existing GET-based clients (qontract-reconcile, etc.)
    csrfPrevention: false,
    plugins: [
      ApolloServerPluginCacheControlDisabled(),
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
  own?: RegisterApollo,
) => {
  const middleware = expressMiddleware(server, {
    context: async (): Promise<IContext> => ({ schemas: [] }),
  });
  const expiration = Date.now() + BUNDLE_SHA_TTL;

  const lifecycle: ApolloLifecycle = app.get('apolloLifecycle');
  const register = own ?? lifecycle.add.bind(lifecycle);
  register(bundleSha, server, () => {
    delete app.get('bundles')[bundleSha];
    app.get('shaRouters').delete(bundleSha);
    delete app.get('bundleCache')[bundleSha];
    delete app.get('searchableFields')[bundleSha];
    delete app.get('datafileSchemas')[bundleSha];
    delete app.get('objectTypes')[bundleSha];
    delete app.get('objectInterfaces')[bundleSha];
    metrics.updateCacheMetrics(app);
  });
  app
    .get('shaRouters')
    .set(
      bundleSha,
      async (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        const release = lifecycle.acquire(bundleSha);
        if (!release) {
          next();
          return;
        }
        try {
          // Await the integration's whole pipeline, even if the client disconnects.
          await middleware(req, res, next);
        } finally {
          release();
        }
      },
    );

  // add to the cache

  app.get('bundleCache')[bundleSha] = {
    expiration,
  } as ICacheInfo;

  // set as latest sha
  app.set('latestBundleSha', bundleSha);
};

// A started instance must have an owner, including when shutdown refuses registration.
const buildAndRegisterApolloServer = async (
  app: express.Express,
  sha: string,
  own?: RegisterApollo,
) => {
  const server = await buildApolloServer(app, sha);
  try {
    registerApolloServer(app, sha, server, own);
  } catch (error) {
    await server.stop().catch((stopError: unknown) => {
      logger.error(
        'failed to stop unregistered Apollo server for bundle %s: %s',
        sha,
        stopError instanceof Error ? stopError.message : 'unknown error',
      );
    });
    throw error;
  }
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

      // Retirement runs in the background so a long query cannot block reload.
      const lifecycle: ApolloLifecycle = app.get('apolloLifecycle');
      void lifecycle.retire(sha).catch((error: unknown) => {
        logger.error(
          'failed to retire Apollo server for bundle %s: %s',
          sha,
          error instanceof Error ? error.message : 'unknown error',
        );
      });
    }
  }
};

// Create application
export const appFromBundle = async (bundlePromises: Promise<db.Bundle>[]) => {
  const app: express.Express = express();
  const lifecycle = new ApolloLifecycle();
  app.set('apolloLifecycle', lifecycle);

  // Create the initial `bundles` object. This object will have this shape:
  // bundles:
  //   <bundleSha>: <bundle>
  app.set('bundles', {});

  // Create cache object
  app.set('bundleCache', {});

  // Per-SHA router map: sha -> Apollo expressMiddleware
  app.set('shaRouters', new Map<string, express.RequestHandler>());

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
          return handler(req, res, next);
        }
      }
      next();
    },
  );

  try {
    for (const bp of bundlePromises) {
      const bundle = await bp;
      const sha = bundle.fileHash;
      if (app.get('shaRouters').has(sha)) continue;
      app.get('bundles')[sha] = bundle;
      logger.info('loading initial bundle %s', sha);
      await buildAndRegisterApolloServer(app, sha);
    }
  } catch (error) {
    await lifecycle.stopAll().catch((stopError: unknown) => {
      logger.error(
        'failed to stop Apollo servers after startup failure: %s',
        stopError instanceof Error ? stopError.message : 'unknown error',
      );
    });
    throw error;
  }

  app.post('/reload', async (req: express.Request, res: express.Response) => {
    await lifecycle.trackLoad(async (own) => {
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
      await buildAndRegisterApolloServer(app, bundleSha, own);

      metrics.updateResourceMetrics(bundle);
      metrics.updateCacheMetrics(app);

      logger.info('bundle loaded: %s', bundleSha);
      res.send();
    });
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

      const dataDiffs = microdiff(
        Object.fromEntries(baseBundle.datafiles),
        Object.fromEntries(headBundle.datafiles),
        { cyclesFix: false },
      );
      const resourceDiffs = microdiff(
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
        { cyclesFix: false },
      );

      const changes: any = {
        datafiles: {},
        resources: {},
      };

      resourceDiffs.forEach((diff) => {
        const path = String(diff.path[0]);
        const oldRes = baseBundle.resourcefiles.get(path);
        const newRes = headBundle.resourcefiles.get(path);
        changes.resources[path] = {
          resourcepath: path,
          old: oldRes,
          new: newRes,
        };
      });

      dataDiffs.forEach((diff) => {
        const path = String(diff.path[0]);
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

// One owner for HTTP draining and every per-bundle Apollo instance.
export const startHttpServer = (app: express.Express, port = 4000) => {
  const server = app.listen({ port }, () => {
    logger.info('Running at http://localhost:%s/graphql', port);
  });
  let shutdown: Promise<void> | undefined;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shutdown) return;
      logger.info('%s received, draining HTTP and Apollo servers', signal);
      shutdown = shutdownHttpServer(server, app.get('apolloLifecycle'));
      void shutdown.then(
        () => {
          logger.info('HTTP and Apollo servers stopped');
        },
        (error: unknown) => {
          logger.error(
            'server shutdown failed: %s',
            error instanceof Error ? error.message : 'unknown error',
          );
          process.exit(1);
        },
      );
    });
  }
  return server;
};

// If this is main, load an app from the environment and run the server.
if (require.main === module) {
  appFromBundle(db.getInitialBundles()).then((app) => {
    startHttpServer(app);
    metrics.updateCacheMetrics(app);
    metrics.updateResourceMetrics(
      app.get('bundles')[app.get('latestBundleSha')],
    );
  });
}
