const ALLOWED_PREFIXES = ["mlc-ai/", "onnx-community/"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/hf/")) return proxyHuggingFace(request, url);
    return env.ASSETS.fetch(request);
  }
};

async function proxyHuggingFace(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { "Allow": "GET, HEAD" } });
  }

  let path;
  try {
    path = decodeURIComponent(url.pathname.slice(4)).replace(/^\/+/, "");
  } catch {
    return new Response("Bad model path", { status: 400 });
  }

  if (!path || path.includes("..") || !ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return new Response("Model path not allowed", { status: 403 });
  }

  const target = new URL("https://huggingface.co/" + path);
  target.search = url.search;

  const headers = new Headers();
  for (const name of ["accept", "range", "if-none-match", "if-modified-since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      redirect: "follow"
    });

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("set-cookie");
    responseHeaders.set("x-retention-model-proxy", "workers-static-assets");
    responseHeaders.set("access-control-allow-origin", "*");
    responseHeaders.set("access-control-expose-headers", "content-length,content-range,etag,accept-ranges");

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    return new Response("Upstream model fetch failed: " + (error && error.message ? error.message : String(error)), {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
}
