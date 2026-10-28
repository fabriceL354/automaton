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
// Limiter les alias aux deux imports partages effectivement utilises.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isSharedPreview = context.originModulePath === path.join(
    sharedDirectory,
    'research-mobile-preview.ts'
  );
  const isSharedReception = context.originModulePath === path.join(
    sharedDirectory,
    'research-reception.ts'
  );
  let sourceName = moduleName;
  if (isSharedPreview && moduleName === './research-evidence-policy.js') {
    sourceName = './research-evidence-policy';
  } else if (isSharedReception && moduleName === './research-mobile-preview.js') {
    sourceName = './research-mobile-preview';
  }

  return context.resolveRequest(context, sourceName, platform);
};

module.exports = config;
