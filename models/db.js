const fs = require('fs');
const path = require('path');
const jsonpointer = require('jsonpointer');
const { JSONPath } = require('jsonpath-plus');
const _ = require('lodash');
var AWS = require('aws-sdk');

var s3 = new AWS.S3({
  'AccessKeyID': process.env.AWS_ACCESS_KEY_ID,
  'SecretAccessKey': process.env.AWS_SECRET_ACCESS_KEY,
  'Region': process.env.AWS_REGION,
});

var s3params = {
  Bucket: process.env.AWS_S3_BUCKET,
  Key: process.env.AWS_S3_KEY,
};

// utils

var isRef = function (obj) {
  if (obj.constructor === Object) {
    if (_.isEqual(_.keys(obj), ['$ref']) || _.isEqual(_.keys(obj), ['$jsonpathref'])) {
      return true;
    }
  }
  return false;
}

var getRefPath = function (ref) {
  return /^[^$]*/.exec(ref)[0];
}

var getRefExpr = function (ref) {
  m = /[$#].*/.exec(ref);
  return m ? m[0] : "";
}

var resolvePath = function (relPath, basePath) {
  if (relPath == '.' || relPath == "") {
    return basePath;
  } else if (relPath[0] == '/') {
    return relPath.substr(1);
  } else {
    return path.join(path.dirname(basePath), relPath);
  }
}

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
  for (datafile of datafiles) {
    if (schema_in_filter.includes(datafile["$schema"])) {
      match_datafiles.push(datafile);
    }
  }

  return match_datafiles;
}

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

  for (datafile of datafiles) {
    var datafile_labels = datafile["labels"];

    if (typeof (datafile_labels) == "undefined") {
      continue;
    }

    var match = true;

    for (var label in label_filter) {
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
}

// main db object
var db = {
  // collect datafiles
  "datafiles": [],
  "datafile": {},

  // filter functions
  "labelFilter": labelFilter,
  "schemaInFilter": schemaInFilter,

  // utils
  "resolveRef": function (itemRef, datafilePath) {
    let ref, resolveFunc;

    if (ref = itemRef['$ref']) {
      resolveFunc = (d, e) => jsonpointer.get(d, e);
    } else if (ref = itemRef['$jsonpathref']) {
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

    let resolvedData = resolveFunc(datafile, expr)

    if (typeof (resolvedData) == "undefined") {
      console.log(`Error resolving ref: datafile: '${JSON.stringify(datafile)}', expr: '${expr}'.`);
    }

    return resolvedData;
  },
  "isRef": isRef,
  "load": () => {
    console.log(`Start datafile reload: ${new Date()}`);

    s3.getObject(s3params, function (err, data) {
      if (err) {
        console.log(err, err.stack);
      } else {
        let dbDatafileNew = {};
        let dbDatafilesNew = [];

        let raw = data.Body.toString('utf-8');
        let datafilePack = JSON.parse(raw);

        for (d of datafilePack) {
          let datafilePath = d[0];
          let datafileData = d[1];

          datafileData['path'] = datafilePath;

          dbDatafilesNew.push(datafileData);
          dbDatafileNew[datafilePath] = datafileData;

          console.log(`Load: ${datafilePath}`);
        }

        db.datafile = dbDatafileNew;
        db.datafiles = dbDatafilesNew;

        console.log(`End datafile reload: ${new Date()}`);
      }
    });
  }
};

module.exports = db;
