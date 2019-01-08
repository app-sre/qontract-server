require('dotenv').config();

const { ApolloServer, gql } = require("apollo-server-express");
const express = require("express");

const db = require('./models/db');
const base = require('./graphql-schemas/base');

db.load();

var schemaFiles = [
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

var typeDefs = [];
var resolvers = {};

for (var schema of schemaFiles) {
    var schemaItem = require(`./graphql-schemas/${schema}`);
    typeDefs.push(schemaItem.typeDefs);

    for (var key in schemaItem.resolvers) {
        resolvers[key] = schemaItem.resolvers[key];
    }
}

const app = express();

const server = new ApolloServer({
    typeDefs,
    resolvers,
    fieldResolver: base.defaultResolver
});

function ensurePresentData(req, res, next) {
    let urls = ['/graphql', '/sha256', '/health-check'];

    if (urls.includes(req.url)) {
        if (db.datafiles.length == 0 || db.sha256 == "") {
            res.status(503).send('No loaded data.');
        }
    }

    next();
}

app.use(ensurePresentData);

server.applyMiddleware({ app });

app.get('/reload', (req, res) => { db.load(); res.send(); });
app.get('/sha256', (req, res) => { res.send(db.sha256); });
app.get('/health-check', (req, res) => { res.send(); });
app.get('/', (req, res) => { res.redirect('/graphql'); });

app.listen({ port: 4000 }, () =>
    console.log(`Running at http://localhost:4000${server.graphqlPath}`));
