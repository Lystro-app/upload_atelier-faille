// Minimaler, spec-konformer OAuth-2.1-Authorization-Server für den
// claude.ai-Remote-MCP-Connector.
//
// Alles stateless über signierte JWTs (HS256, MCP_OAUTH_SECRET) — übersteht
// Server-Neustarts, kein Client-/Code-Store nötig. Single-User: der /authorize-
// Login prüft ein einziges Passwort (MCP_LOGIN_PASSWORD).
//
// Exponierte Endpoints (alle ohne Basic Auth, siehe basicAuth.ts):
//   GET  /.well-known/oauth-protected-resource[/mcp]
//   GET  /.well-known/oauth-authorization-server
//   POST /register        (Dynamic Client Registration, Public Clients)
//   GET  /authorize        (Login-Formular + PKCE)
//   POST /authorize        (Login-Submit -> Auth-Code)
//   POST /token            (code + refresh, form-urlencoded)

import express, { type Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import { SignJWT, jwtVerify } from "jose";

const ISSUER = (process.env.APP_URL || "").replace(/\/$/, "");
const RESOURCE = `${ISSUER}/mcp`;
const LOGIN_PASSWORD = process.env.MCP_LOGIN_PASSWORD || "";
const ALG = "HS256";

// Resolved on use, not at import. server.ts imports this module before
// dotenv.config(), so a module-level read would miss .env.local and a
// module-level throw would stop local dev before env is loaded.
function oauthSecret(): Uint8Array {
  const secret = process.env.MCP_OAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "MCP_OAUTH_SECRET is not set. Refusing to start so /mcp tokens cannot be forged. " +
        "Set MCP_OAUTH_SECRET to a random value (openssl rand -hex 32)."
    );
  }
  return new TextEncoder().encode(secret);
}

const CODE_TTL = 300;            // 5 min
const ACCESS_TTL = 3600;         // 1 h
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 d

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// redirect_uri-Allowlist: claude.ai-Callback + loopback (Claude Code).
function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:" && u.hostname === "claude.ai") return true;
    if ((u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
  return timingSafeEqual(hash, challenge);
}

async function signToken(payload: Record<string, unknown>, ttl: number, aud?: string) {
  const b = new SignJWT(payload)
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`);
  if (aud) b.setAudience(aud);
  return b.sign(oauthSecret());
}

// ── Bearer-Verify-Middleware für /mcp ────────────────────────────────────────
export async function verifyBearer(req: Request, res: Response, next: NextFunction) {
  const challenge = () => {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`
    );
    res.status(401).json({ error: "invalid_token" });
  };
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return challenge();
  try {
    const { payload } = await jwtVerify(header.slice(7), oauthSecret(), {
      issuer: ISSUER,
      audience: RESOURCE,
    });
    if (payload.typ !== "at") return challenge();
    next();
  } catch {
    challenge();
  }
}

function loginForm(params: Record<string, string>, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join("\n    ");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atelier Faille – MCP-Zugang</title>
<style>
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
  form{background:#1c1c1c;padding:2rem;border-radius:12px;width:min(90vw,340px);box-shadow:0 10px 40px rgba(0,0,0,.5)}
  h1{font-size:1.1rem;margin:0 0 1rem}
  input[type=password]{width:100%;padding:.7rem;border-radius:8px;border:1px solid #333;background:#000;color:#fff;box-sizing:border-box}
  button{margin-top:1rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#c9a24b;color:#111;font-weight:600;cursor:pointer}
  .err{color:#ff6b6b;font-size:.85rem;margin-top:.6rem}
  .sub{color:#888;font-size:.8rem;margin-top:.4rem}
</style></head><body>
  <form method="post" action="/authorize">
    <h1>Atelier Faille · Upload freigeben</h1>
    ${hidden}
    <input type="password" name="password" placeholder="MCP-Passwort" autofocus required>
    <button type="submit">Zugang erteilen</button>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <div class="sub">Claude darf danach Produkte in den Live-Shop hochladen.</div>
  </form>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

export function createMcpOAuthRouter(): Router {
  // Fail closed once environment files have been loaded (see oauthSecret).
  oauthSecret();
  const router = express.Router();
  const form = express.urlencoded({ extended: true });

  // ── Discovery: Protected Resource Metadata ────────────────────────────────
  const protectedResource = (_req: Request, res: Response) => {
    res.json({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  };
  router.get("/.well-known/oauth-protected-resource", protectedResource);
  router.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  // ── Discovery: Authorization Server Metadata ──────────────────────────────
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  // ── Dynamic Client Registration (Public Clients) ──────────────────────────
  router.post("/register", express.json(), (req, res) => {
    const body = req.body || {};
    const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirectUris.some(u => !redirectAllowed(u))) {
      return res.status(400).json({ error: "invalid_redirect_uri" });
    }
    const clientId = "mcp-" + crypto.randomBytes(16).toString("hex");
    res.status(201).json({
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });

  // ── Authorize: Login-Formular ─────────────────────────────────────────────
  router.get("/authorize", (req, res) => {
    const q = req.query as Record<string, string>;
    if (!q.redirect_uri || !redirectAllowed(q.redirect_uri)) {
      return res.status(400).send("invalid redirect_uri");
    }
    if (q.response_type !== "code") return res.status(400).send("unsupported response_type");
    if (q.code_challenge_method !== "S256" || !q.code_challenge) {
      return res.status(400).send("PKCE S256 erforderlich");
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(loginForm({
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      state: q.state || "",
      resource: q.resource || RESOURCE,
      scope: q.scope || "mcp",
    }));
  });

  // ── Authorize: Login-Submit -> Auth-Code ──────────────────────────────────
  router.post("/authorize", form, async (req, res) => {
    const b = req.body || {};
    const redirectUri = String(b.redirect_uri || "");
    if (!redirectAllowed(redirectUri)) return res.status(400).send("invalid redirect_uri");

    if (!LOGIN_PASSWORD || !timingSafeEqual(String(b.password || ""), LOGIN_PASSWORD)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(401).send(loginForm({
        redirect_uri: redirectUri,
        code_challenge: String(b.code_challenge || ""),
        state: String(b.state || ""),
        resource: String(b.resource || RESOURCE),
        scope: String(b.scope || "mcp"),
      }, "Falsches Passwort."));
    }

    const code = await signToken({
      typ: "code",
      cc: String(b.code_challenge || ""),
      ru: redirectUri,
      res: String(b.resource || RESOURCE),
      scope: String(b.scope || "mcp"),
    }, CODE_TTL);

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (b.state) url.searchParams.set("state", String(b.state));
    res.redirect(url.toString());
  });

  // ── Token: authorization_code + refresh_token ─────────────────────────────
  router.post("/token", form, async (req, res) => {
    const b = req.body || {};
    const grant = String(b.grant_type || "");

    try {
      if (grant === "authorization_code") {
        const { payload } = await jwtVerify(String(b.code || ""), oauthSecret(), { issuer: ISSUER });
        if (payload.typ !== "code") return res.status(400).json({ error: "invalid_grant" });
        if (payload.ru !== String(b.redirect_uri || "")) {
          return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        }
        if (!b.code_verifier || !pkceMatches(String(b.code_verifier), String(payload.cc || ""))) {
          return res.status(400).json({ error: "invalid_grant", error_description: "PKCE failed" });
        }
        const aud = String(payload.res || RESOURCE);
        const scope = String(payload.scope || "mcp");
        const access = await signToken({ typ: "at", scope }, ACCESS_TTL, aud);
        const refresh = await signToken({ typ: "rt", scope }, REFRESH_TTL, aud);
        return res.json({
          access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL,
          refresh_token: refresh, scope,
        });
      }

      if (grant === "refresh_token") {
        const { payload } = await jwtVerify(String(b.refresh_token || ""), oauthSecret(), { issuer: ISSUER });
        if (payload.typ !== "rt") return res.status(400).json({ error: "invalid_grant" });
        const aud = String(payload.aud || RESOURCE);
        const scope = String(payload.scope || "mcp");
        const access = await signToken({ typ: "at", scope }, ACCESS_TTL, aud);
        const refresh = await signToken({ typ: "rt", scope }, REFRESH_TTL, aud);
        return res.json({
          access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL,
          refresh_token: refresh, scope,
        });
      }

      return res.status(400).json({ error: "unsupported_grant_type" });
    } catch {
      return res.status(400).json({ error: "invalid_grant" });
    }
  });

  return router;
}
