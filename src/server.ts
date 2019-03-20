import * as util from 'util';
import * as fs from 'fs';

import { ApolloServer, gql } from 'apollo-server-express';
import * as express from 'express';

import * as db from './db';
import { generateAppSchema, defaultResolver  } from './schema';

const readFile = util.promisify(fs.readFile);

export const appFromBundle = async(bundle: Promise<db.Bundle>) => {
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

  app.get('/reload', async (req: express.Request, res: express.Response) => {
    try {
      const bundle = await db.bundleFromEnvironment();
      req.app.set('bundle', bundle);
      req.app.get('server').schema = generateAppSchema(req.app as express.Express);

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
