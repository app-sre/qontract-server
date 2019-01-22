require('dotenv').config();

import { ApolloServer, gql } from 'apollo-server-express';
import * as express from 'express';

const db = require('./models/db');
const base = require('./graphql-schemas/base');

db.load();

const schemaFiles = [
  'base',
  'vaultSecret',
  'entity',
  'bot',
  'user',
  'permission',
  'role',
  'cluster',
  'quay-org',
];

const schemas = schemaFiles.map((file) => { return require(`./graphql-schemas/${file}`); });
const typeDefs = schemas.map((schema) => { return schema.typeDefs; });
const resolvers = schemas.reduce(
  (acc, schema) => {
    const resolvers = Object.entries(schema.resolvers).reduce(
      (resolverAcc, tuple) => {
        const resolverName = tuple[0];
        const resolverValue = tuple[1];
        return { ...resolverAcc, [resolverName]: resolverValue };
      },
      {});
    return { ...acc, ...resolvers };
  },
  {});

const app = express();
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if ((!['/', '/reload'].includes(req.url)) && (db.datafiles.length === 0 || db.sha256 === '')) {
    res.status(503).send('No loaded data.');
    return;
  }
  next();
});

const server = new ApolloServer({
  typeDefs,
  resolvers,
  fieldResolver: base.defaultResolver,
});
server.applyMiddleware({ app });

app.get('/reload',  (req: express.Request, res: express.Response) => { db.load(); res.send(); });
app.get('/sha256',  (req: express.Request, res: express.Response) => { res.send(db.sha256); });
app.get('/healthz', (req: express.Request, res: express.Response) => { res.send(); });
app.get('/',        (req: express.Request, res: express.Response) => { res.redirect('/graphql'); });

module.exports = app.listen({ port: 4000 }, () => {
  console.log(`Running at http://localhost:4000${server.graphqlPath}`);
});
