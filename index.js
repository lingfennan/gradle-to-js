#!/usr/bin/env node
'use strict';

var fs = require('fs');
var parser = require('./lib/parser');
var args = process.argv.slice(2);
var path = args[0];
var rootPaths = args.length > 1? args.slice(1): null;

if (!path) {
  console.error('No input detected! Usage: node index.js path [rootPath1 rootPath2 ...]');
  return;
}

if (fs.statSync(path)) {
  parser.parseFile(path, rootPaths).then(function(parsedValue) {
    console.log(JSON.stringify(parsedValue, '', 2));
  });
}

