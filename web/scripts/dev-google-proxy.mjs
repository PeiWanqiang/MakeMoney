/**
 * Local-only sidecar: forwards the Google OAuth token exchange through an
 * HTTP(S) forward proxy for developers whose network can't reach Google
 * directly. workerd (the Worker runtime `vinext dev` runs on) does not read
 * HTTP_PROXY/HTTPS_PROXY, so the Worker's own `fetch()` call can't use one.
 * This plain Node process can, via undici's ProxyAgent, so the Worker calls
 * this local endpoint instead when GOOGLE_TOKEN_PROXY_URL is set.
 *
 * Run alongside `npm run dev`, in a separate terminal: `npm run dev:google-proxy`.
 */
import { createServer } from "node:http";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const PROXY_URL = process.env.DEV_HTTP_PROXY || "http://127.0.0.1:9090";
const PORT = Number(process.env.DEV_GOOGLE_PROXY_PORT || 8791);
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

setGlobalDispatcher(new ProxyAgent(PROXY_URL));

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/token") {
    res.writeHead(404).end("not found");
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  try {
    const upstream = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] ?? "application/x-www-form-urlencoded" },
      body,
    });
    const text = await upstream.text();
    console.log(`[dev-google-proxy] token request -> ${upstream.status}`);
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(text);
  } catch (error) {
    console.error(`[dev-google-proxy] request via ${PROXY_URL} failed:`, error);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_fetch_failed", message: String(error) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dev-google-proxy] http://127.0.0.1:${PORT}/token -> ${GOOGLE_TOKEN_ENDPOINT} via ${PROXY_URL}`);
});
