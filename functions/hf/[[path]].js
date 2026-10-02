const ALLOWED_PREFIXES = [
  'mlc-ai/',
  'onnx-community/'
];

export async function onRequest(context) {
  const request = context.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { 'Allow': 'GET, HEAD' } });
  }

  let path = context.params.path;
  if (Array.isArray(path)) path = path.join('/');
  path = String(path || '').replace(/^\/+/, '');

  if (!path || path.includes('..') || !ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return new Response('Model path not allowed', { status: 403 });
  }

  const incoming = new URL(request.url);
  const target = new URL('https://huggingface.co/' + path);
  target.search = incoming.search;

  const forwardHeaders = new Headers();
  ['accept', 'range', 'if-none-match', 'if-modified-since'].forEach(name => {
    const value = request.headers.get(name);
    if (value) forwardHeaders.set(name, value);
  });

  try {
    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers: forwardHeaders,
      redirect: 'follow'
    });

    const headers = new Headers(upstream.headers);
    headers.delete('set-cookie');
    headers.set('x-retention-model-proxy', 'cloudflare');
    headers.set('access-control-allow-origin', '*');
    headers.set('access-control-expose-headers', 'content-length,content-range,etag,accept-ranges');

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  } catch (error) {
    return new Response('Upstream model fetch failed: ' + (error && error.message ? error.message : String(error)), {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
}
