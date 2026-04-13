/**
 * Fishndrop Backend Bootstrap
 * This file ensures that 'npx nodemon server' correctly runs the TypeScript source.
 */
require('ts-node/register');
console.log('\x1b[33m%s\x1b[0m', '[BOOTSTRAP] Starting Fishndrop Backend from Source...');
require('./src/index.ts');
// Force restart
