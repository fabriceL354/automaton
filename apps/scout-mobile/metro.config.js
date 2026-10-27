const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);

// Autoriser la lecture des regles Scout partagees.
const sharedDirectory = path.resolve(
  __dirname,
  '../../src/agent'
);

config.watchFolders = [
  ...new Set([
    ...(config.watchFolders ?? []),
    sharedDirectory
  ])
];

module.exports = config;
