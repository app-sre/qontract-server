import express = require('express');
import promClient = require('prom-client');
import {
  DocumentNode,
  FragmentDefinitionNode,
  Kind,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql';
import * as db from './db';
import { Datafile } from './types';

const promBundle = require('express-prom-bundle');

interface IAcct {
  [key: string]: number;
}

// metrics middleware for express-prom-bundle
export const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  normalizePath: [['^/graphqlsha/.*', '/graphqlsha/#sha']],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  formatStatusCode: (res: express.Response) =>
    `${Math.floor(res.statusCode / 100)}xx`,
});

// enable prom-client to expose default application metrics
promClient.collectDefaultMetrics({ prefix: 'qontract_server_' });

// Shared by every per-bundle Apollo server. Buckets include sub-millisecond work.
const graphqlDurationBuckets = [
  0.0001, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
  2.5, 5, 10,
];

export const graphqlOperationDuration = new promClient.Histogram({
  name: 'qontract_server_graphql_operation_duration_seconds',
  help: 'Apollo request duration through response post-processing, in seconds',
  labelNames: ['operation', 'root_field', 'outcome'],
  buckets: graphqlDurationBuckets,
});

export const graphqlExecutionDuration = new promClient.Histogram({
  name: 'qontract_server_graphql_execution_duration_seconds',
  help: 'GraphQL execution duration, including failed executions, in seconds',
  labelNames: ['operation', 'root_field'],
  buckets: graphqlDurationBuckets,
});

export const graphqlPostprocessDuration = new promClient.Histogram({
  name: 'qontract_server_graphql_postprocess_duration_seconds',
  help: 'Response empty-object removal duration, in seconds',
  labelNames: ['operation'],
  buckets: graphqlDurationBuckets,
});

// Operation names are client-controlled. Only configured names become labels.
export const graphqlOperationAllowlist = (
  configured = process.env.GRAPHQL_METRICS_OPERATIONS ??
    'Rolebindings,Users,Namespaces',
): Set<string> =>
  new Set(
    configured
      .split(',')
      .map((name) => name.trim())
      .filter((name) => /^[_A-Za-z][_0-9A-Za-z]{0,127}$/.test(name))
      .slice(0, 50),
  );

export const graphqlOperationLabels = (
  document: DocumentNode,
  operation: OperationDefinitionNode,
  allowedOperations: ReadonlySet<string>,
): { operation: string; root_field: string } => {
  const name = operation.name?.value;
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  const roots = new Set<string>();
  const visitedFragments = new Set<string>();
  const collectRoots = (selectionSet: SelectionSetNode) => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        roots.add(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        collectRoots(selection.selectionSet);
      } else if (!visitedFragments.has(selection.name.value)) {
        visitedFragments.add(selection.name.value);
        const fragment = fragments.get(selection.name.value);
        if (fragment) collectRoots(fragment.selectionSet);
      }
    }
  };
  // Called after validation: field names belong to the schema, never aliases.
  // This describes the operation shape, including conditionally skipped roots.
  collectRoots(operation.selectionSet);
  return {
    operation: name
      ? allowedOperations.has(name)
        ? name
        : 'other'
      : 'anonymous',
    root_field:
      roots.size === 1
        ? roots.values().next().value
        : roots.size
          ? 'multiple'
          : 'none',
  };
};

// Create metric stores
const reloadCounter = new promClient.Counter({
  name: 'qontract_server_reloads_total',
  help: 'Number of reloads for qontract server',
});

const datafilesGauge = new promClient.Gauge({
  name: 'qontract_server_datafiles',
  help: 'Number of datafiles for a specific schema',
  labelNames: ['schema'],
});

const bundleGauge = new promClient.Gauge({
  name: 'qontract_server_bundle_object_shas',
  help: 'Number of shas cached by the application in the bundle object',
});

const bundleCacheGauge = new promClient.Gauge({
  name: 'qontract_server_bundle_cache_object_shas',
  help: 'Number of shas cached by the application in the bundleCache object',
});

export const updateCacheMetrics = (app: express.Express) => {
  bundleGauge.set(Object.keys(app.get('bundles')).length);
  bundleCacheGauge.set(Object.keys(app.get('bundleCache')).length);
};

// Count number of files for each schema type
const buildSchemaCount = (datafiles: Map<string, Datafile>): IAcct => {
  const acc: IAcct = {};

  for (const datafile of datafiles.values()) {
    const schema = datafile.$schema;
    const count = acc[schema];
    acc[schema] = (count === undefined ? 0 : count) + 1;
  }
  return acc;
};

export const updateResourceMetrics = (bundle: db.Bundle) => {
  const schemaCount: IAcct = buildSchemaCount(bundle.datafiles);

  // Set the Gauge based on counted metrics
  Object.entries(schemaCount).forEach(([schemaName, count]) =>
    datafilesGauge.set({ schema: schemaName }, count),
  );

  reloadCounter.inc(1);
};
