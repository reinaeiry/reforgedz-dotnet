#!/usr/bin/env node
// Writes .env.example from tools/lib/envManifest.js so the template can never
// drift from what the code reads. npm run env:example
const fs = require('fs');
const path = require('path');
const { renderExample } = require('./lib/envManifest');

const out = path.join(__dirname, '..', '.env.example');
fs.writeFileSync(out, renderExample());
console.log(`wrote ${out}`);
