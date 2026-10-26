// Run legacy source-oriented tests against current modules, without rebuilding
// the generated website or depending on an already committed bundle.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..'), read = fs.readFileSync;
const spec = JSON.parse(read(path.join(root, 'test-app/modules.json'), 'utf8'));
let html = read(path.join(root, 'test-app/src/shell.html'), 'utf8');
for (const module of spec.modules) {
  const tag = module.kind === 'style' ? 'style' : 'script';
  let code = module.sources.map(source => read(path.join(root, 'test-app/src', source), 'utf8')).join('');
  if (tag === 'script') code = code.replace(/<\/script/gi, '<\\/script');
  html = html.replace('<!-- TEST-MODULE:' + module.name + ' -->', () => '<' + tag + module.attributes + '>' + code + '</' + tag + '>');
}
fs.readFileSync = function (file, options) {
  if (typeof file === 'string' && path.resolve(file) === path.join(root, 'index-test.html')) {
    return options === 'utf8' || options?.encoding === 'utf8' ? html : Buffer.from(html);
  }
  return read.apply(this, arguments);
};
