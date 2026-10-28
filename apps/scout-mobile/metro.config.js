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
// Limiter cet alias au module partage qui verifie les preuves de recherche.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isSharedPreview = context.originModulePath === path.join(
    sharedDirectory,
    'research-mobile-preview.ts'
  );
  const sourceName = isSharedPreview &&
    moduleName === './research-evidence-policy.js'
    ? './research-evidence-policy'
    : moduleName;

  return context.resolveRequest(context, sourceName, platform);
};

module.exports = config;
