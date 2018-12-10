const fs = require('fs');
const path = require('path');
const jsonpointer = require('jsonpointer');
const { JSONPath } = require('jsonpath-plus');
var AWS = require('aws-sdk');

// utils

var isRef = function (obj) {
  if (obj.constructor === Object) {
    if (Object.keys(obj).length == 1 && ('$ref' in obj || '$jsonpathref' in obj)) {
      return true;
    }
  }
  return false;
};

var isNonEmptyArray = function (obj) {
  return obj.constructor === Array && obj.length > 0;
};

var getRefPath = function (ref) {
  return /^[^$]*/.exec(ref)[0];
};

var getRefExpr = function (ref) {
  m = /[$#].*/.exec(ref);
  return m ? m[0] : "";
};

var resolvePath = function (relPath, basePath) {
  if (relPath == '.' || relPath == "") {
    return basePath;
  } else if (relPath[0] == '/') {
    return relPath.substr(1);
  } else {
    return path.join(path.dirname(basePath), relPath);
  }
};

// filters

var schemaInFilter = function (schema_in_filter, input_set) {
  var datafiles;

  if (typeof (input_set) == "undefined") {
    datafiles = this.datafiles;
  } else {
    datafiles = input_set;
  }

  if (typeof (schema_in_filter) == "undefined") {
    return datafiles;
  }

  var match_datafiles = [];
  for (let datafile of datafiles) {
    if (schema_in_filter.includes(datafile.$schema)) {
      match_datafiles.push(datafile);
    }
  }

  return match_datafiles;
};

var labelFilter = function (label_filter, input_set) {
  var datafiles;

  if (typeof (input_set) == "undefined") {
    datafiles = this.datafiles;
  } else {
    datafiles = input_set;
  }

  if (typeof (label_filter) == "undefined") {
    return datafiles;
  }

  var match_datafiles = [];

  for (let datafile of datafiles) {
    var datafile_labels = datafile.labels;

    if (typeof (datafile_labels) == "undefined") {
      continue;
    }

    var match = true;

    for (let label in label_filter) {
      if (label_filter[label] != datafile_labels[label]) {
        match = false;
        break;
      }
    }

    if (match) {
      match_datafiles.push(datafile);
    }
  }

  return match_datafiles;
};

var resolveRef = function (itemRef, datafilePath) {
  let ref, resolveFunc;

  if (itemRef.$ref) {
    ref = itemRef.$ref;
    resolveFunc = (d, e) => jsonpointer.get(d, e);
  } else if (itemRef.$jsonpathref) {
    ref = itemRef.$jsonpathref;
    resolveFunc = (d, e) => JSONPath({ json: d, path: e });
  } else {
    throw "Invalid ref object";
  }

  let path = getRefPath(ref);
  let expr = getRefExpr(ref);

  let targetDatafilePath = resolvePath(path, datafilePath);
  let datafile = db.datafile[targetDatafilePath];

  if (typeof (datafile) == "undefined") {
    console.log(`Error retrieving datafile '${targetDatafilePath}'.`);
  }

  let resolvedData = resolveFunc(datafile, expr);

  if (typeof (resolvedData) == "undefined") {
    console.log(`Error resolving ref: datafile: '${JSON.stringify(datafile)}', expr: '${expr}'.`);
  }

  return resolvedData;
};

// datafile Loading functions

var loadUnpack = function(raw) {
  let dbDatafileNew = {};
  let dbDatafilesNew = [];

  let datafilePack = JSON.parse(raw);

  for (let d of datafilePack) {
    let datafilePath = d[0];
    let datafileData = d[1];

    datafileData.path = datafilePath;

    dbDatafilesNew.push(datafileData);
    dbDatafileNew[datafilePath] = datafileData;

    console.log(`Load: ${datafilePath}`);
  }

  db.datafile = dbDatafileNew;
  db.datafiles = dbDatafilesNew;

  console.log(`End datafile reload: ${new Date()}`);
};

var loadFromS3 = function () {
  var s3 = new AWS.S3({
    'AccessKeyID': process.env.AWS_ACCESS_KEY_ID,
    'SecretAccessKey': process.env.AWS_SECRET_ACCESS_KEY,
    'Region': process.env.AWS_REGION,
  });

  var s3params = {
    Bucket: process.env.AWS_S3_BUCKET,
    Key: process.env.AWS_S3_KEY,
  };

  s3.getObject(s3params, function (err, data) {
    if (err) {
      console.log(err, err.stack);
    } else {
      loadUnpack(data.Body.toString('utf-8'));
    }
  });
};

var loadFromFile = function () {
  var raw = fs.readFileSync(process.env.DATAFILES_FILE);
  loadUnpack(raw);
};

var load = function () {
  console.log(`Start datafile reload: ${new Date()}`);

  switch (process.env.LOAD_METHOD) {
    case "fs":
      console.log("Loading from fs.");
      loadFromFile();
      break;
    case "s3":
      console.log("Loading from s3.");
      loadFromS3();
      break;
    default:
      throw new Error(`Unknown LOAD_METHOD ${process.env.LOAD_METHOD}`);
  }
};

// main db object

var db = {
  // collect datafiles
  "datafiles": [],
  "datafile": {},

  // filter functions
  "labelFilter": labelFilter,
  "schemaInFilter": schemaInFilter,

  // utils
  "resolveRef": resolveRef,
  "isRef": isRef,
  "isNonEmptyArray": isNonEmptyArray,
  "load": load,
};

module.exports = db;
