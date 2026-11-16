// 4.0 TEST migration adapter. Not loaded by the published client yet.
// The existing durable offline queue owns retries and optimistic UI updates.
export class SynologyTransportError extends Error {
  constructor(code, {status = 0, retryable = false, uncertain = false} = {}) {
    super(code);
    this.name = 'SynologyTransportError';
    Object.assign(this, {code, status, retryable, uncertain});
  }
}

export function createLineTransport({baseUrl, getIdToken, fetchImpl = globalThis.fetch,
  timeoutMs = 10000} = {}) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new TypeError('invalid-api-url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new TypeError('api-url-must-be-https-without-credentials');
  if (typeof getIdToken !== 'function' || typeof fetchImpl !== 'function')
    throw new TypeError('token-provider-and-fetch-required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new TypeError('invalid-timeout');
  const endpoint = url.href.replace(/\/$/, '') + '/api/v1/line/operations';

  async function submit(operation) {
    // Serialize before awaiting authentication. Reuse these exact bytes on auth retry.
    if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
        typeof operation.id !== 'string' || !operation.id)
      throw new SynologyTransportError('operation-id-required');
    const body = JSON.stringify(operation);
    for (let attempt = 0; attempt < 2; attempt++) {
      let token;
      try { token = await getIdToken(attempt === 1); }
      catch { throw new SynologyTransportError('authentication-unavailable', {retryable:true}); }
      if (typeof token !== 'string' || !token)
        throw new SynologyTransportError('authentication-required');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method:'POST', headers:{'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
          body, signal:controller.signal, redirect:'error', cache:'no-store',
          credentials:'omit', referrerPolicy:'no-referrer'
        });
        if (response.status === 401 && attempt === 0) continue;
        if (!response.ok) {
          const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
          throw new SynologyTransportError('api-http-' + response.status, {
            status:response.status, retryable,
            uncertain:retryable // A gateway error can arrive after the DB committed.
          });
        }
        let result;
        try { result = await response.json(); }
        catch { throw new SynologyTransportError('invalid-api-response', {retryable:true, uncertain:true}); }
        if (!result || !['confirmed','rejected'].includes(result.outcome) ||
            (result.outcome === 'confirmed' && (!result.status || typeof result.status !== 'object' || Array.isArray(result.status))) ||
            (result.outcome === 'rejected' && typeof result.reason !== 'string'))
          throw new SynologyTransportError('invalid-api-response', {retryable:true, uncertain:true});
        return result;
      } catch (error) {
        if (error instanceof SynologyTransportError) throw error;
        throw new SynologyTransportError(controller.signal.aborted ? 'api-timeout' : 'api-unreachable',
          {retryable:true, uncertain:true});
      } finally { clearTimeout(timer); }
    }
  }
  return Object.freeze({endpoint, submit});
}
