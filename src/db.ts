import * as fs from 'fs';
import * as util from 'util';
import { createHash } from 'crypto';

import * as aws from 'aws-sdk';
import { logger } from './logger';
import { buildSyntheticBackRefTrie, SyntheticBackRefTrie } from './syntheticBackRefTrie';
import { Datafile, GraphQLSchemaType } from './types';

// cannot use `import` (old package with no associated types)
const jsonpointer = require('jsonpointer');

export type ResourcefileBackRef = {
  path: string;
  datafileSchema: string;
  type: string;
  jsonpath: string;
};

export type Resourcefile = {
  path: string;
  content: string;
  sha256sum: string;
  backrefs: ResourcefileBackRef[];
};

export type Bundle = {
  datafiles: Map<string, Datafile>;
  datafilesBySchema: Map<string, Array<Datafile>>;
  fileHash: string;
  gitCommit: string;
  gitCommitTimestamp: string;
  resourcefiles: Map<string, Resourcefile>;
  schema: GraphQLSchemaType | any[];
  syntheticBackRefTrie: SyntheticBackRefTrie;
};

const getRefPath = (ref: string): string => /^[^$]*/.exec(ref)[0];

const getRefExpr = (ref: string): string => {
  const m = /[$#].*/.exec(ref);
  return m ? m[0] : '';
};

export type Referencing = {
  $ref: string;
};

export const resolveRef = (bundle: Bundle, itemRef: Referencing) : any => {
  const path = getRefPath(itemRef.$ref);
  const expr = getRefExpr(itemRef.$ref);

  const datafile = bundle.datafiles.get(path);
  if (typeof (datafile) === 'undefined') {
    logger.error('Error retrieving datafile: %s', path);
    return null;
  }

  const resolvedData = jsonpointer.get(datafile, expr);
  if (typeof (resolvedData) === 'undefined') {
    logger.error(
      'Error resolving ref: datafile: "%s", expr: "%s"',
      JSON.stringify(datafile),
      expr,
    );
    return null;
  }

  return resolvedData;
};

const validateObject = (path: string, data: object, requiredFields: string[]) : void => {
  if (typeof path !== 'string') { throw new Error('Expecting string for path'); }
  if (typeof data !== 'object') { throw new Error('Expecting object for data'); }

  const fields = new Set(Object.keys(data));
  if (fields.size === 0) {
    throw new Error('Expected keys in data');
  }

  requiredFields.forEach((field) => {
    if (!fields.has(field)) {
      throw new Error(`Expecting ${field} in data`);
    }
  });
};

const parseDatafiles = (jsonData: object) : Map<string, Datafile> => {
  const entries : [string, Datafile][] = Object
    .entries(jsonData)
    .map(([path, data]: [string, Datafile]) => {
      validateObject(path, data, ['$schema']);
      return [
        path,
        {
          ...data,
          path,
        },
      ];
    });
  return new Map(entries);
};

const hashDatafile = (contents: string) => createHash('sha256').update(contents).digest('hex');

const parseResourcefiles = (jsonData: object) : Map<string, Resourcefile> => {
  const entries : [string, Resourcefile][] = Object
    .entries(jsonData)
    .map(([path, data]: [string, Resourcefile]) => {
      validateObject(path, data, ['path', 'content', 'sha256sum']);
      return [
        path,
        {
          ...data,
          path,
        },
      ];
    });
  return new Map(entries);
};

const buildDatafilesBySchema = (datafiles: Map<string, Datafile>): Map<string, Array<Datafile>> => {
  const datafilesBySchema = new Map<string, Array<Datafile>>();
  datafiles.forEach((datafile) => {
    const schema = datafile.$schema;
    const group = datafilesBySchema.get(schema);
    if (group === undefined) {
      datafilesBySchema.set(schema, [datafile]);
    } else {
      group.push(datafile);
    }
  });
  return datafilesBySchema;
};

const parseBundle = (contents: string) : Bundle => {
  const parsedContents = JSON.parse(contents);
  const datafiles = parseDatafiles(parsedContents.data);
  const datafilesBySchema = buildDatafilesBySchema(datafiles);
  const schema = parsedContents.graphql;
  const syntheticBackRefTrie = buildSyntheticBackRefTrie(datafilesBySchema, schema);
  return {
    datafiles,
    datafilesBySchema,
    schema,
    syntheticBackRefTrie,
    fileHash: hashDatafile(contents),
    gitCommit: parsedContents.git_commit,
    gitCommitTimestamp: parsedContents.git_commit_timestamp,
    resourcefiles: parseResourcefiles(parsedContents.resources),
  } as Bundle;
};

const bundleFromS3 = async (
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  bucket: string,
  key: string,
) => {
  const s3 = new aws.S3({ accessKeyId, secretAccessKey, region });
  try {
    await s3.waitFor(
      'objectExists',
      { Bucket: bucket, Key: key, $waiter: { delay: 5, maxAttempts: 20 } },
    ).promise();
  } catch (error) {
    throw new Error(`key ${key} not found in s3 bucket ${bucket}`);
  }
  const getObject = util.promisify(s3.getObject.bind(s3));
  const response = await getObject({ Bucket: bucket, Key: key });
  const contents = response.Body.toString('utf-8');

  return parseBundle(contents);
};

export const bundleFromDisk = async (path: string) => {
  const loadPath = typeof (path) === 'undefined' ? process.env.DATAFILES_FILE : path;
  const readFile = util.promisify(fs.readFile);
  const contents = String(await readFile(loadPath));
  return parseBundle(contents);
};

export const bundleFromEnvironment = async () => {
  switch (process.env.LOAD_METHOD) {
    case 'fs':
      return bundleFromDisk(process.env.DATAFILES_FILE);
    case 's3':
      return bundleFromS3(
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY,
        process.env.AWS_REGION,
        process.env.AWS_S3_BUCKET,
        process.env.AWS_S3_KEY,
      );
    default:
      return {
        datafiles: new Map<string, Datafile>(),
        resourcefiles: new Map<string, Resourcefile>(),
        schema: {},
        fileHash: '',
        gitCommit: '',
        gitCommitTimestamp: '',
      } as Bundle;
  }
};

export const getInitialBundles = () => {
  if (process.env.INIT_BUNDLES) {
    return process.env.INIT_BUNDLES.split(',').map((bundleUrl: any) => {
      const urlParts = bundleUrl.split('://');
      switch (urlParts[0]) {
        case 'fs':
          return bundleFromDisk(urlParts[1]);
        case 's3':
          return bundleFromS3(
            process.env.AWS_ACCESS_KEY_ID,
            process.env.AWS_SECRET_ACCESS_KEY,
            process.env.AWS_REGION,
            process.env.AWS_S3_BUCKET,
            urlParts[1],
          );
        default:
          throw new Error(`incorrect bundle ${bundleUrl} specified`);
      }
    });
  }
  return [bundleFromEnvironment()];
};
