import * as util from 'util';
import * as fs from 'fs';

import { ApolloServer } from 'apollo-server-express';
import * as express from 'express';

import * as db from './db';
import { generateAppSchema, defaultResolver } from './schema';

import promClient = require('prom-client');
const promBundle = require('express-prom-bundle');

import { GraphQLSchema } from 'graphql';

interface IAcct {
  [key: string]: number;
}

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

const readFile = util.promisify(fs.readFile);

export const appFromBundle = async (bundle: Promise<db.Bundle>) => {
  const app: express.Express = express();

  app.set('bundle', await bundle);

  app.use(metricsMiddleware);

  // Register a middleware that will 503 if we haven't loaded a Bundle yet.
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((!['/', '/reload'].includes(req.url)) && (req.app.get('bundle').datafiles.size === 0)) {
      res.status(503).send('No loaded data.');
      return;
    }
    next();
  });
  // Register a middleware that will redirect requests from graphql/<sha> to /graphql
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const hash = req.app.get('bundle').fileHash;
    if (req.url.startsWith('/graphqlsha/')) {
      if (req.url === `/graphqlsha/${hash}`) {
        req.url = '/graphql';
      } else {
        res.status(409).send(`Current sha is: ${hash}`);
      }
    }
    next();
  });

  let server: ApolloServer;

  try {
    server = new ApolloServer({
      schema: generateAppSchema(app),
      playground: true,
      introspection: true,
      fieldResolver: defaultResolver(app),
    });
  } catch (e) {
    console.error(`error creating server: ${e}`);
    process.exit(1);
  }

  app.set('server', server);

  server.applyMiddleware({ app });

  app.post('/reload', async (req: express.Request, res: express.Response) => {
    try {
      const bundle = await db.bundleFromEnvironment();

      req.app.set('bundle', bundle);

      const schema: GraphQLSchema = generateAppSchema(req.app as express.Express);

      // https://github.com/apollographql/apollo-server/issues/1275#issuecomment-532183702
      // @ts-ignore
      const schemaDerivedData = await server.generateSchemaDerivedData(schema);

      req.app.get('server').schema = schema;
      req.app.get('server').schemaDerivedData = schemaDerivedData;

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
    const hash = req.app.get('bundle').fileHash;
    res.send(hash);
  });

  app.get('/git-commit', (req: express.Request, res: express.Response) => {
    const git_commit = req.app.get('bundle').gitCommit;
    res.send(git_commit);
  });

  app.get('/metrics', (req: express.Request, res: express.Response) => {
    res.send(promClient.register.metrics());
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
  });
}
