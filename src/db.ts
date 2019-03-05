import * as fs from 'fs';
import * as util from 'util';

import * as aws from 'aws-sdk';
import * as im from 'immutable';
import { md as forgeMd } from 'node-forge';

// cannot use `import` (old package with no associated types)
const jsonpointer = require('jsonpointer');

export type Datafile = {
  $schema: string;
  path: string;
  [key: string]: any;
};

export type Resourcefile = {
  path: string;
  content: string;
  shasum256: string;
};

export type Bundle = {
  datafiles: im.Map<string, Datafile>;
  resourcefiles: im.Map<string, Resourcefile>;
  fileHash: string;
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
    console.log(`Error retrieving datafile '${path}'.`);
    return null;
  }

  const resolvedData = jsonpointer.get(datafile, expr);
  if (typeof (resolvedData) === 'undefined') {
    console.log(`Error resolving ref: datafile: '${JSON.stringify(datafile)}', expr: '${expr}'.`);
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
        fileHash: '',
      } as Bundle;
  }
};
