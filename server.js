require('dotenv').config()

const { ApolloServer, gql } = require("apollo-server-express");
const express = require("express");
const merge = require('lodash/merge');

const db = require('./models/db');
const base = require('./schemas/base');

db.load();

var schemaFiles = [
    'base',
    'entity',
    'bot',
    'user',
    'permission',
    'role',
];

var typeDefs = [];
var resolvers = {};

for (schema of schemaFiles) {
    var schemaItem = require(`./schemas/${schema}`);
    typeDefs.push(schemaItem.typeDefs);
    resolvers = merge(resolvers, schemaItem.resolvers);
}

const app = express();

const server = new ApolloServer({
    typeDefs,
    resolvers,
    fieldResolver: base.defaultResolver
});

server.applyMiddleware({ app });

app.get('/reload', (req, res) => { db.load(); res.send() });

app.listen({ port: 4000 }, () =>
    console.log(`Running at http://localhost:4000${server.graphqlPath}`));
