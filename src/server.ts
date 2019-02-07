require('dotenv').config();

import { ApolloServer, gql } from 'apollo-server-express';
import * as express from 'express';

import * as db from './db';
import { generateAppSchema, defaultResolver  } from './schema';

db.load();

const app = express();
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if ((!['/', '/reload'].includes(req.url)) && (db.datafilesLength() === 0 || db.sha256() === '')) {
    res.status(503).send('No loaded data.');
    return;
  }
  next();
});

const server = new ApolloServer({
  schema: generateAppSchema('assets/schema.yml'),
  playground: true,
  introspection: true,
  fieldResolver: defaultResolver,
});

server.applyMiddleware({ app });

app.get('/reload', (req: express.Request, res: express.Response) => {
  db.load(); res.send();
});

app.get('/sha256', (req: express.Request, res: express.Response) => { res.send(db.sha256()); });
app.get('/healthz', (req: express.Request, res: express.Response) => { res.send(); });

app.get('/', (req: express.Request, res: express.Response) => { res.redirect('/graphql'); });

module.exports = app.listen({ port: 4000 }, () => {
  console.log(`Running at http://localhost:4000${server.graphqlPath}`);
});
