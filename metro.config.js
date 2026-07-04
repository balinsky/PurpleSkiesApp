const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allow Metro to bundle .wasm files (needed for expo-sqlite web worker)
config.resolver.assetExts.push('wasm');

module.exports = config;
