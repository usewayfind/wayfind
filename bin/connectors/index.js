'use strict';

const github = require('./github');
const intercom = require('./intercom');
const notion = require('./notion');

const connectors = { github, intercom, notion };

module.exports = {
  get(name) { return connectors[name] || null; },
  list() { return Object.keys(connectors); },
  all() { return connectors; },
};
