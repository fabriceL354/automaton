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

// Le moteur NodeNext nomme ses imports .js ; Metro lit ici les sources .ts.
// Limiter les alias aux imports partages effectivement utilises.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const aliases = [
    ['research-mobile-preview.ts', './research-evidence-policy.js', './research-evidence-policy'],
    ['research-mobile-preview.ts', './research-data-boundary.js', './research-data-boundary'],
    ['research-reception.ts', './research-mobile-preview.js', './research-mobile-preview'],
    ['research-mobile-import.ts', './research-evidence-policy.js', './research-evidence-policy'],
    ['research-mobile-import.ts', './research-data-boundary.js', './research-data-boundary'],
    ['research-public-sync.ts', './research-mobile-import.js', './research-mobile-import'],
    ['research-public-sync.ts', './research-data-boundary.js', './research-data-boundary'],
    ['research-sync-https-preparation.ts', './research-public-sync.js', './research-public-sync']
  ];
  const match = aliases.find(([origin, name]) =>
    context.originModulePath === path.join(sharedDirectory, origin) && moduleName === name
  );
  return context.resolveRequest(context, match ? match[2] : moduleName, platform);
};

module.exports = config;
