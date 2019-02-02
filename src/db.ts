const fs = require('fs');
const jsonpointer = require('jsonpointer');
const AWS = require('aws-sdk');
const forge = require('node-forge');

// utils

const getRefPath = function (ref: any) {
  return /^[^$]*/.exec(ref)[0];
};

const getRefExpr = function (ref: any) {
  const m = /[$#].*/.exec(ref);
  return m ? m[0] : '';
};

// filters

export function getDatafilesBySchema(schema: string) {
  return Object.values(datafiles).filter((d: any) => d.$schema === schema);
}

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

// datafile Loading functions

const loadUnpack = function (raw: any) {
  const dbDatafilesNew: any = {};

  const bundle = JSON.parse(raw);

  const sha256temp = forge.md.sha256.create();
  sha256temp.update(raw);

  const sha256hex: string = sha256temp.digest().toHex();

  Object.entries(bundle).forEach((d) => {
    const datafilePath: any = d[0];
    const datafileData: any = d[1];

    if (typeof(datafilePath) !== 'string') {
      throw new Error('Expecting string for datafilePath');
    }

    if (typeof (datafileData) !== 'object' ||
          Object.keys(datafileData).length === 0 ||
          !('$schema' in datafileData)) {
      throw new Error('Invalid datafileData object');
    }

    datafileData.path = datafilePath;

    dbDatafilesNew[datafilePath] = datafileData;
  });

  datafiles = dbDatafilesNew;
  sha256 = sha256hex;

  console.log(`End datafile reload: ${new Date()}`);
};

const loadFromS3 = function () {
  const s3 = new AWS.S3({
    AccessKeyID: process.env.AWS_ACCESS_KEY_ID,
    SecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    Region: process.env.AWS_REGION,
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
};

export function loadFromFile(path: any) {
  let loadPath: string;

  if (typeof(path) === 'undefined') {
    loadPath = process.env.DATAFILES_FILE;
  } else {
    loadPath = path;
  }

  const raw = fs.readFileSync(loadPath);
  loadUnpack(raw);
};

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

// main db object
export let datafiles: any = {};
export let sha256: string = '';
