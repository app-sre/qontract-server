import * as fs from 'fs';
import * as util from 'util';

import * as aws from 'aws-sdk';
import * as im from 'immutable';
import { md as forgeMd } from 'node-forge';
import { logger } from './logger';

// cannot use `import` (old package with no associated types)
const jsonpointer = require('jsonpointer');

export type Datafile = {
  $schema: string;
  path: string;
  [key: string]: any;
};

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
  datafiles: im.Map<string, Datafile>;
  resourcefiles: im.Map<string, Resourcefile>;
  schema: any[];
  fileHash: string;
  gitCommit: string;
  gitCommitTimestamp: string;
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
    logger.error('Error resolving ref: datafile: "%s", expr: "%s"',
                 JSON.stringify(datafile), expr);
    return null;
  }

  return resolvedData;
};

const parseBundle = (contents: string) : Bundle => {
  const parsedContents = JSON.parse(contents);

  return {
    datafiles: parseDatafiles(parsedContents.data),
    resourcefiles: parseResourcefiles(parsedContents.resources),
    fileHash: hashDatafile(contents),
    gitCommit: parsedContents['git_commit'],
    gitCommitTimestamp: parsedContents['git_commit_timestamp'],
    schema: parsedContents.graphql,
  } as Bundle;
};

const parseDatafiles = (jsonData: object) : im.Map<string, Datafile> => {
  return Object.entries(jsonData).reduce(
    (acc: im.Map<string, Datafile>, [path, data]: [string, Datafile]) => {
      validateObject(path, data, ['$schema']);
      data.path = path;
      return acc.set(path, data);
    },
    im.Map());
};

const validateObject = (path: string, data: object, requiredFields: string[]) : void => {
  if (typeof path !== 'string') { throw new Error('Expecting string for path'); }
  if (typeof data !== 'object') { throw new Error('Expecting object for data'); }

  const fields = Object.keys(data);
  if (fields.length === 0) {
    throw new Error('Expected keys in data');
  }

  requiredFields.forEach((field) => {
    if (!fields.includes(field)) {
      throw new Error(`Expecting ${field} in data`);
    }
  });
};

const parseResourcefiles = (jsonData: object) : im.Map<string, Resourcefile> => {
  return Object.entries(jsonData).reduce(
    (acc: im.Map<string, Resourcefile>, [path, data]: [string, Resourcefile]) => {
      validateObject(path, data, ['path', 'content', 'sha256sum']);
      data.path = path;
      return acc.set(path, data);
    },
    im.Map());
};

const hashDatafile = (contents: string) => {
  return forgeMd.sha256.create().update(contents).digest().toHex();
};

const bundleFromS3 = async(accessKeyId: string, secretAccessKey: string, region: string,
                           bucket: string, key: string) => {
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

export const bundleFromDisk = async(path: string) => {
  const loadPath = typeof (path) === 'undefined' ? process.env.DATAFILES_FILE : path;
  const readFile = util.promisify(fs.readFile);
  const contents = String(await readFile(loadPath));
  return parseBundle(contents);
};

export const getInitialBundles = () => {
  if (process.env.INIT_BUNDLES) {
    return process.env.INIT_BUNDLES.split(',').map((bundleUrl: any) => {
      const urlParts = bundleUrl.split('://');
      switch (urlParts[0]) {
        case 'fs':
          return bundleFromDisk(urlParts[1]);
        case 's3':
          return bundleFromS3(process.env.AWS_ACCESS_KEY_ID,
                              process.env.AWS_SECRET_ACCESS_KEY,
                              process.env.AWS_REGION,
                              process.env.AWS_S3_BUCKET,
                              urlParts[1]);
        default:
          throw new Error(`incorrect bundle ${bundleUrl} specified`);
      }
    });
  }
  return [bundleFromEnvironment()];
};

export const bundleFromEnvironment = async() => {
  switch (process.env.LOAD_METHOD) {
    case 'fs':
      return bundleFromDisk(process.env.DATAFILES_FILE);
    case 's3':
      return bundleFromS3(process.env.AWS_ACCESS_KEY_ID,
                          process.env.AWS_SECRET_ACCESS_KEY,
                          process.env.AWS_REGION,
                          process.env.AWS_S3_BUCKET,
                          process.env.AWS_S3_KEY);
    default:
      return {
        datafiles: im.Map<string, Datafile>(),
        resourcefiles: im.Map<string, Resourcefile>(),
        schema: {},
        fileHash: '',
        gitCommit: '',
        gitCommitTimestamp: '',
      } as Bundle;
  }
};
