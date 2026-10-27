'use strict';
// Test-only infrastructure. This module has no browser/dependency side effects.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const PROJECT = 'demo-samosval-browser-audit';
const DEMO_CONFIG = Object.freeze({projectId: PROJECT, apiKey: 'local-demo-not-a-credential',
  appId: 'local-demo-app', authDomain: '127.0.0.1', storageBucket: PROJECT + '.invalid'});
const FIRESTORE_PROBE_FIXTURE = Object.freeze({
  asset:'test-app/vendor/firebase-firestore-compat-10.8.0.js',
  originalSha256:'1b122566975332a8b7059e1b435df73122b6e4947b312360b518936be219b6fc',
  path:'/Samosval/audit-connectivity-probe.gif'
});
// Real, transparent 1×1 GIF. The diagnostic must use the network rather than a
// data URL/cache hit, so offline image failure remains genuine.
const PROBE_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json',
  '.png':'image/png','.ttf':'font/ttf','.json':'application/json'};

async function readWithRulesDisabled(environment, read) {
  // RulesTestEnvironment.withSecurityRulesDisabled resolves void, not the
  // callback's return value. Capture the actual SDK result without replacing it.
  let result;
  await environment.withSecurityRulesDisabled(async context => { result=await read(context); });
  return result;
}

function pngDetails(bytes) {
  assert(Buffer.isBuffer(bytes), 'PNG must be actual downloaded bytes');
  assert(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'Invalid PNG signature');
  let offset=8, dimensions, imageData=0, ended=false;
  while (offset + 12 <= bytes.length) {
    const size=bytes.readUInt32BE(offset), type=bytes.toString('ascii',offset+4,offset+8);
    assert(size <= bytes.length-offset-12, 'Truncated PNG chunk');
    if (type==='IHDR') {
      assert(!dimensions && offset===8 && size===13, 'Invalid PNG header');
      dimensions={width:bytes.readUInt32BE(offset+8),height:bytes.readUInt32BE(offset+12)};
      assert(dimensions.width>0 && dimensions.height>0,'Empty PNG');
    }
    if (type==='IDAT') imageData+=size;
    offset+=size+12;
    if (type==='IEND') { assert.equal(size,0); ended=true; break; }
  }
  assert(dimensions && imageData>0 && ended && offset===bytes.length, 'Incomplete PNG image');
  return dimensions;
}

function allowedUrl(raw, origin, firestorePort) {
  try {
    const url = new URL(raw);
    return !url.username && !url.password && url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && (url.origin === origin || url.port === String(firestorePort));
  } catch (_) { return false; }
}

function rewriteDemoSource(source, isCore = false) {
  // Keep production source/build files untouched. Only deployment identifiers change.
  let result = source.replaceAll('samosval-offline', PROJECT);
  if (isCore) {
    const pattern = /const firebaseConfig\s*=\s*\{[\s\S]*?\};/g;
    assert.equal([...result.matchAll(pattern)].length, 1, 'Expected exactly one Firebase config in built core');
    result = result.replace(pattern, 'const firebaseConfig = ' + JSON.stringify(DEMO_CONFIG) + ';');
    assert(result.includes("const TEST_FIREBASE_PROJECT_ID = '" + PROJECT + "'"), 'Demo project guard missing');
  }
  return result;
}

function rewriteConnectivityProbe(bytes) {
  // WebChannel uses a Google image only to classify transport failures. Its
  // adjacent scheme-forcing expression also needs replacement: changing just
  // the URL would turn a relative loopback URL into an invalid HTTPS URL.
  // Pin the complete original SDK; fail closed on upgrades or a changed fragment.
  // No transport, retry, callback, persistence or transaction code is changed.
  assert.equal(createHash('sha256').update(bytes).digest('hex'),FIRESTORE_PROBE_FIXTURE.originalSha256,
    'Unexpected Firestore vendor bytes: review the local connectivity probe fixture');
  const source=bytes.toString();
  const original='n=new Ct("//www.google.com/images/cleardot.gif"),x.location&&"http"==x.location.protocol||Nt(n,"https"),Mt(n)';
  const replacement='n=new Ct(' + JSON.stringify(FIRESTORE_PROBE_FIXTURE.path) + '),Mt(n)';
  assert.equal(source.split(original).length,2,'Expected exactly one pinned WebChannel connectivity probe');
  return Buffer.from(source.replace(original,replacement));
}

function createLocalServer(root, firestorePort, requestLog) {
  root = fs.realpathSync(root);
  const servedBytes = file => {
    const bytes = fs.readFileSync(file), relative = path.relative(root,file).split(path.sep).join('/');
    if (relative === 'index-test.html') return Buffer.from(rewriteDemoSource(bytes.toString(),true));
    if (relative === FIRESTORE_PROBE_FIXTURE.asset) return rewriteConnectivityProbe(bytes);
    if (relative.startsWith('test-app/build/') && relative.endsWith('.js'))
      return Buffer.from(rewriteDemoSource(bytes.toString(),relative.endsWith('/core.js')));
    if (relative === 'sw-test.js') {
      // The production worker verifies every response hash. Preserve that check
      // against the exact demo response bytes; do not disable integrity checking.
      const worker = bytes.toString(), pattern = /^const RECORDS = (\[.*\]);$/m;
      assert(pattern.test(worker),'Expected service-worker release manifest');
      const records = JSON.parse(worker.match(pattern)[1]).map(record => {
        const asset = path.resolve(root,record.url);
        assert(asset.startsWith(root + path.sep) && asset !== file,'Invalid worker asset path');
        return {...record,sha256:createHash('sha256').update(servedBytes(asset)).digest('hex')};
      });
      return Buffer.from(worker.replace(pattern,'const RECORDS = ' + JSON.stringify(records) + ';'));
    }
    return bytes;
  };
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      requestLog.push({at:new Date().toISOString(), method:req.method, path:url.pathname});
      res.setHeader('Cache-Control', 'no-cache');
      // Worker requests can bypass Playwright routing. Enforce the same local-only
      // connect policy on the document AND every service-worker response.
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:" + firestorePort + "; worker-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'");
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      if (url.pathname === FIRESTORE_PROBE_FIXTURE.path) {
        // Intentionally absent from the worker's precache. Offline requests fail
        // normally; no external request is made and no synthetic onload is fired.
        res.setHeader('Cache-Control','no-store');
        res.setHeader('Content-Type','image/gif');
        res.end(req.method === 'HEAD' ? undefined : PROBE_GIF); return;
      }
      if (url.pathname === '/Samosval/audit-observer') {
        res.setHeader('Content-Type', types['.html']); res.end('<!doctype html><title>Local audit observer</title>'); return;
      }
      if (!url.pathname.startsWith('/Samosval/')) { res.writeHead(404); res.end(); return; }
      const relative = decodeURIComponent(url.pathname.slice('/Samosval/'.length));
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()
          || !fs.realpathSync(file).startsWith(root + path.sep)
          || !/^(?:index-test\.html|manifest-test\.webmanifest|sw-test\.js|test-app\/(?:build|vendor|icons|src)\/[^?]+|assets\/[^?]+)$/.test(relative)) {
        res.writeHead(404); res.end(); return;
      }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      const content = servedBytes(file);
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { res.writeHead(500); res.end('Local audit server error'); server.emit('audit-error', error); }
  });
  return server;
}

// Serialized by Playwright before application scripts. Firebase Auth alone is a
// deliberate UI fixture; Firestore is the real SDK with emulator mock-user tokens.
function installBrowserFixture({port, uid, project, config, initiallySignedIn = false}) {
  window.__auditFixture = {ready:false, authCalls:[], blockedStorageCalls:0, errors:[], csp:[]};
  window.addEventListener('unhandledrejection', e => {
    const message=String(e.reason?.stack || e.reason); window.__auditFixture.errors.push(message);
    if (typeof window.__auditReport==='function') window.__auditReport('unhandledrejection',{message});
  });
  document.addEventListener('securitypolicyviolation', e => {
    const detail={blockedURI:e.blockedURI,directive:e.violatedDirective}; window.__auditFixture.csp.push(detail);
    if (typeof window.__auditReport==='function') window.__auditReport('csp',detail);
  });
  document.addEventListener('load', function ready(event) {
    if (event.target.tagName !== 'SCRIPT' || !event.target.src.includes('html2pdf-')) return;
    if (window.__auditFixture.ready) throw Error('Duplicate fixture installation');
    const sdk = window.firebase, initialize = sdk.initializeApp.bind(sdk), listeners = new Set();
    const sessionKey = 'local-browser-audit-auth:' + uid;
    const user = {uid, email:uid + '@example.test', displayName:'Локальная проверка'};
    const fakeAuth = {
      currentUser: initiallySignedIn || localStorage.getItem(sessionKey) === 'signed-in' ? user : null,
      onAuthStateChanged(callback) { listeners.add(callback); setTimeout(() => { if (listeners.has(callback)) callback(fakeAuth.currentUser); }, 0); return () => listeners.delete(callback); },
      async signInWithEmailAndPassword(email, password) {
        window.__auditFixture.authCalls.push('signIn');
        if (email !== user.email || password !== 'local-demo-password') throw Object.assign(Error('Fixture: invalid credentials'), {code:'auth/invalid-credential'});
        fakeAuth.currentUser = user; localStorage.setItem(sessionKey, 'signed-in');
        listeners.forEach(callback => callback(user)); return {user};
      },
      async createUserWithEmailAndPassword(email, password) {
        window.__auditFixture.authCalls.push('register');
        if (email !== user.email || password !== 'local-demo-password') throw Object.assign(Error('Fixture: invalid registration'), {code:'auth/invalid-email'});
        fakeAuth.currentUser = user; localStorage.setItem(sessionKey, 'signed-in');
        listeners.forEach(callback => callback(user)); return {user};
      },
      async signOut() { window.__auditFixture.authCalls.push('signOut'); fakeAuth.currentUser = null; localStorage.removeItem(sessionKey); listeners.forEach(callback => callback(null)); }
    };
    sdk.auth = Object.assign(() => fakeAuth, sdk.auth);
    const storage = {setMaxUploadRetryTime(){},setMaxOperationRetryTime(){},ref(){window.__auditFixture.blockedStorageCalls++;throw Error('Firebase Storage is prohibited in this local acceptance suite');}};
    sdk.storage = Object.assign(() => storage, sdk.storage);
    sdk.initializeApp = function (_ignoredConfig, name) {
      if (!project.startsWith('demo-') || config.projectId !== project) throw Error('Only local demo projects are permitted');
      const app = initialize(config, name), firestore = app.firestore();
      firestore.useEmulator('127.0.0.1', port, {mockUserToken:{sub:uid, email:user.email}});
      const settings = firestore.settings.bind(firestore);
      firestore.settings = options => settings({...options, host:'127.0.0.1:' + port, ssl:false});
      app.auth = () => fakeAuth; app.storage = () => storage;
      return app;
    };
    window.__auditFixture.ready = true;
  }, true);
}

module.exports = {PROJECT, DEMO_CONFIG, FIRESTORE_PROBE_FIXTURE, allowedUrl, rewriteDemoSource, rewriteConnectivityProbe, createLocalServer, installBrowserFixture, pngDetails, readWithRulesDisabled};
