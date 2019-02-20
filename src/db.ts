import { readFileSync } from 'fs';
import { S3 } from 'aws-sdk';
import { md as forgeMd } from 'node-forge';

// cannot use `import` (old package with no associated types)
const jsonpointer = require('jsonpointer');

// interfaces
interface IDatafile {
  $schema: string;
  path: string;
}

interface IResource {
  path: string;
  content: string;
  sha256sum: string;
}

interface IDatafilesDict {
  [key: string]: any;
}

interface IResourcesDict {
  [key: string]: any;
}

// module variables
let datafiles: IDatafilesDict = new Map<string, IDatafile>();
let resources: IResourcesDict = new Map<string, IResource>();
let sha256sum: string = '';

// utils
const getRefPath = (ref: string): string => /^[^$]*/.exec(ref)[0];

const getRefExpr = (ref: string): string => {
  const m = /[$#].*/.exec(ref);
  return m ? m[0] : '';
};

export function resolveRef(itemRef: any) {
  const path = getRefPath(itemRef.$ref);
  const expr = getRefExpr(itemRef.$ref);

  const datafile: any = datafiles[path];

  if (typeof (datafile) === 'undefined') {
    console.log(`Error retrieving datafile '${path}'.`);
  }

  const resolvedData = jsonpointer.get(datafile, expr);

  if (typeof (resolvedData) === 'undefined') {
    console.log(`Error resolving ref: datafile: '${JSON.stringify(datafile)}', expr: '${expr}'.`);
  }

  return resolvedData;
}

// filters
export function getDatafilesBySchema(schema: string): IDatafile[] {
  return Object.values(datafiles).filter((d: any) => d.$schema === schema);
}

export function getResource(path: string): IResource {
  return resources[path];
}

export function getResources(): IResource[] {
  return Object.values(resources);
}

// loader
function validateDatafile(d: any) {
  const datafilePath: any = d[0];
  const datafileData: any = d[1];

  if (typeof (datafilePath) !== 'string') {
    throw new Error('Expecting string for datafilePath');
  }

  if (typeof (datafileData) !== 'object' ||
    Object.keys(datafileData).length === 0 ||
    !('$schema' in datafileData)) {
    throw new Error('Invalid datafileData object');
  }
}

function validateResource(d: any) {
  const resourcePath: string = d[0];
  const resourceData: IResource = d[1];

  if (typeof (resourcePath) !== 'string') {
    throw new Error('Expecting string for resourcePath');
  }

  if (typeof (resourceData) !== 'object' ||
    Object.keys(resourceData).length === 0 ||
    !('path' in resourceData) ||
    !('content' in resourceData) ||
    !('sha256sum' in resourceData)) {
    throw new Error('Invalid datafileData object');
  }
}
// datafile Loading functions
function loadUnpack(raw: string) {
  const dbDatafilesNew: any = {};
  const dbResourcesNew: any = {};

  const sha256hex = forgeMd.sha256.create().update(raw).digest().toHex();
  const bundle = JSON.parse(raw);

  Object.entries(bundle.data).forEach((d) => {
    validateDatafile(d);

    const datafilePath: string = d[0];
    const datafileData: any = d[1];

    datafileData.path = datafilePath;

    dbDatafilesNew[datafilePath] = datafileData;
  });

  Object.entries(bundle.resources).forEach((d) => {
    validateResource(d);

    const resourcePath: string = d[0];
    const resourceData: any = d[1];

    resourceData.path = resourcePath;

    dbResourcesNew[resourcePath] = resourceData;
  });

  datafiles = dbDatafilesNew;
  resources = dbResourcesNew;
  sha256sum = sha256hex;

  console.log(`End datafile reload: ${new Date()}`);
}

function loadFromS3() {
  const s3 = new S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
  });

  const s3params = {
    Bucket: process.env.AWS_S3_BUCKET,
    Key: process.env.AWS_S3_KEY,
  };

  s3.getObject(s3params, (err: any, data: any) => {
    if (err) {
      console.log(err, err.stack);
    } else {
      loadUnpack(data.Body.toString('utf-8'));
    }
  });
}

export function loadFromFile(path: string) {
  let loadPath: string;

  if (typeof (path) === 'undefined') {
    loadPath = process.env.DATAFILES_FILE;
  } else {
    loadPath = path;
  }

  const raw = readFileSync(loadPath);
  loadUnpack(String(raw));
}

export function load() {
  console.log(`Start datafile reload: ${new Date()}`);

  switch (process.env.LOAD_METHOD) {
    case 'fs':
      console.log('Loading from fs.');
      loadFromFile(undefined);
      break;
    case 's3':
      console.log('Loading from s3.');
      loadFromS3();
      break;
    default:
      console.log('Skip data loading.');
  }
}

export const sha256 = (): string => sha256sum;
export const datafilesLength = (): number => Object.keys(datafiles).length;
