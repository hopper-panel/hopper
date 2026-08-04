export * from './permissions.js';
export * from './server-state.js';
export * from './node-token.js';

export * from './contract/server-configuration.js';
export * from './contract/daemon-api.js';
export * from './contract/backups.js';
export * from './contract/files.js';
export * from './contract/remote-api.js';
export * from './contract/websocket.js';
export * from './contract/jwt.js';

/** Version du contrat. Le daemon refuse un panel dont la majeure diffère. */
export const CONTRACT_VERSION = '1';
