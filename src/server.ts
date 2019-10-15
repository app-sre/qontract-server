import * as util from 'util';
import * as fs from 'fs';

import { ApolloServer, gql } from 'apollo-server-express';
import * as express from 'express';

import * as db from './db';
import { generateAppSchema, defaultResolver } from './schema';

import prometheusClient = require('prom-client');

interface IAcct {
  [key: string]: number;
}

// enable prom-client to expose default application metrics
const collectDefaultMetrics = prometheusClient.collectDefaultMetrics;

// Probe every 5th second.
collectDefaultMetrics({ prefix: 'qontract_server_' });

// Create metric stores
const reloadCounter = new prometheusClient.Counter({
  name: 'qontract_server_reloads_total',
  help: 'Number of reloads for qontract server'
});

const datafilesGuage = new prometheusClient.Gauge({
  name: 'qontract_server_datafiles',
  help: 'Number of datafiles for a specific schema',
  labelNames: ['schema']
});

const readFile = util.promisify(fs.readFile);

export const appFromBundle = async (bundle: Promise<db.Bundle>) => {
  const app: express.Express = express();

  app.set('bundle', await bundle);

  // Register a middleware that will 503 if we haven't loaded a Bundle yet.
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((!['/', '/reload'].includes(req.url)) && (req.app.get('bundle').datafiles.size === 0)) {
      res.status(503).send('No loaded data.');
      return;
    }
    next();
  });

  let server;
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
      req.app.get('server').schema = generateAppSchema(req.app as express.Express);

      // Count number of files for each schema type
      let schema_count: IAcct = bundle.datafiles.reduce((acc: IAcct, d) => {
        if (!(d.$schema in acc)) {
          acc[d.$schema] = 0;
        }
        acc[d.$schema]++;
        return acc;
      }, {});

      // Set the Guage based on counted metrics
      Object.keys(schema_count).map(function (schemaName, _) {
        datafilesGuage.set({ schema: schemaName }, schema_count[schemaName]);
      })
      reloadCounter.inc(1, Date.now())
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

  app.get('/metrics', (req: express.Request, res: express.Response) => {
    res.send(prometheusClient.register.metrics());
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
