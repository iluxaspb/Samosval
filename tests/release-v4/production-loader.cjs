// Reuse domain regression scenarios against production source and the production bundle.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const originalRead = fs.readFileSync, originalResolve = Module._resolveFilename;
const production = file => typeof file === 'string' ? file.replace(/(^|\/)test-app\//, '$1app/') : file;
fs.readFileSync = function(file, options) { return originalRead.call(this, production(file), options); };
Module._resolveFilename = function(request, ...args) { return originalResolve.call(this, production(request), ...args); };
const readerPath = path.join(root, 'tools/read-test-html.cjs');
const reader = new Module(readerPath);
reader.filename = readerPath;
reader.loaded = true;
reader.exports = () => originalRead(path.join(root, 'index.html'), 'utf8')
  .replace(/<script\b([^>]*?)\ssrc="(\.\/app\/[^"]+)"([^>]*)><\/script>/g, (_, a, url, b) => '<script' + a + b + '>' + originalRead(path.join(root, url), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>')
  .replace(/<link rel="stylesheet"([^>]*?) href="(\.\/app\/[^"]+)"\s*>/g, (_, a, url) => '<style' + a + '>' + originalRead(path.join(root, url), 'utf8') + '</style>');
require.cache[readerPath] = reader;
