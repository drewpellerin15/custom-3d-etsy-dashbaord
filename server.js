const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CONFIG_PATH = path.join(__dirname, "config.json");
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const ETSY_API_BASE = "https://api.etsy.com/v3/application";
const SHIPPO_API_BASE = "https://api.goshippo.com";
const OAUTH_COOKIE_NAME = "etsy_oauth";
const AUTH_COOKIE_NAME = "dashboard_auth";
const listingImageCache = new Map();
const shippoTrackingCache = new Map();
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "3739";
const REQUIRED_CONFIG_FIELDS = [
  "etsy_api_key",
  "etsy_api_secret",
  "etsy_redirect_uri",
  "shop_id"
];

app.use(cors());
app.use(express.json());

// ================= CONFIG =================
function loadConfig() {
  const fileConfig = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    : {};

  return {
    ...fileConfig,
    etsy_api_key: process.env.ETSY_API_KEY || fileConfig.etsy_api_key,
    etsy_api_secret: process.env.ETSY_API_SECRET || fileConfig.etsy_api_secret,
    etsy_redirect_uri: process.env.ETSY_REDIRECT_URI || fileConfig.etsy_redirect_uri,
    shop_id: process.env.ETSY_SHOP_ID || fileConfig.shop_id,
    shippo_api_key: process.env.SHIPPO_API_KEY || fileConfig.shippo_api_key,
    etsy_access_token: process.env.ETSY_ACCESS_TOKEN || fileConfig.etsy_access_token,
    etsy_refresh_token: process.env.ETSY_REFRESH_TOKEN || fileConfig.etsy_refresh_token
  };
}

let config = loadConfig();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : value;
}

function normalizeConfig() {
  config.etsy_api_key = trimString(config.etsy_api_key);
  config.etsy_api_secret = trimString(config.etsy_api_secret);
  config.etsy_redirect_uri = trimString(config.etsy_redirect_uri);
  config.etsy_access_token = trimString(config.etsy_access_token);
  config.etsy_refresh_token = trimString(config.etsy_refresh_token);

  if (typeof config.shop_id === "string") {
    config.shop_id = config.shop_id.trim();
  }
}

function missingFields(fields) {
  normalizeConfig();
  return fields.filter((field) => {
    const value = config[field];
    return value === undefined || value === null || String(value).trim() === "";
  });
}

function requireConfig(fields) {
  const missing = missingFields(fields);
  if (missing.length) {
    const message = `Missing required config field(s): ${missing.join(", ")}`;
    const error = new Error(message);
    error.status = 500;
    throw error;
  }
}

function etsyApiKeyHeaderValue() {
  requireConfig(["etsy_api_key", "etsy_api_secret"]);
  return `${config.etsy_api_key}:${config.etsy_api_secret}`;
}

function requireAccessToken() {
  normalizeConfig();
  if (!config.etsy_access_token) {
    const error = new Error("Missing etsy_access_token. Visit /oauth to connect Etsy first.");
    error.status = 401;
    throw error;
  }
}

// ================= LOGGING =================
function redact(value) {
  if (!value) return value;
  const stringValue = String(value);
  if (stringValue.length <= 12) return "[redacted]";
  return `${stringValue.slice(0, 8)}...[redacted]...${stringValue.slice(-4)}`;
}

function safeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (key.toLowerCase() === "authorization") {
        return [key, "Bearer [redacted]"];
      }

      if (key.toLowerCase() === "x-api-key") {
        return [key, redact(value)];
      }

      if (key.toLowerCase() === "authorization" && String(value).startsWith("ShippoToken")) {
        return [key, "ShippoToken [redacted]"];
      }

      return [key, value];
    })
  );
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

function logEtsyRequest(label, url, headers) {
  console.log(`[Etsy ${label}] Request`, {
    url,
    headers: safeHeaders(headers)
  });
}

function logEtsyResponse(label, response, body) {
  console.log(`[Etsy ${label}] Response`, {
    status: response.status,
    ok: response.ok,
    body
  });
}

function logShippoRequest(label, url) {
  console.log(`[Shippo ${label}] Request`, { url });
}

function logShippoResponse(label, response, body) {
  console.log(`[Shippo ${label}] Response`, {
    status: response.status,
    ok: response.ok,
    body: body
      ? {
          carrier: body.carrier,
          tracking_number: body.tracking_number,
          tracking_status: body.tracking_status
            ? {
                status: body.tracking_status.status,
                status_details: body.tracking_status.status_details,
                status_date: body.tracking_status.status_date
              }
            : undefined,
          messages: body.messages
        }
      : body
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

// ================= PKCE =================
function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function createCodeVerifier() {
  return base64UrlEncode(crypto.randomBytes(64));
}

function createCodeChallenge(codeVerifier) {
  return base64UrlEncode(crypto.createHash("sha256").update(codeVerifier).digest());
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};

  return Object.fromEntries(
    header.split(";").map((cookie) => {
      const index = cookie.indexOf("=");
      if (index === -1) return [decodeURIComponent(cookie.trim()), ""];
      const key = decodeURIComponent(cookie.slice(0, index).trim());
      const value = decodeURIComponent(cookie.slice(index + 1).trim());
      return [key, value];
    })
  );
}

function authCookieValue() {
  return crypto
    .createHmac("sha256", DASHBOARD_PASSWORD)
    .update("custom-3d-dashboard")
    .digest("hex");
}

function isAuthenticated(req) {
  return parseCookies(req)[AUTH_COOKIE_NAME] === authCookieValue();
}

function setAuthCookie(res) {
  const secure = process.env.NODE_ENV === "production";
  const parts = [
    `${AUTH_COOKIE_NAME}=${authCookieValue()}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=2592000"
  ];

  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

function loginPage(errorMessage = "") {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Custom 3D Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      display: grid;
      place-items: center;
      background: #101318;
      color: #f3f5f7;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    form {
      width: min(360px, calc(100vw - 32px));
      display: grid;
      gap: 14px;
      padding: 22px;
      border: 1px solid rgba(190, 199, 210, 0.16);
      border-radius: 8px;
      background: #171b22;
    }
    h1 { margin: 0 0 4px; font-size: 1.6rem; }
    label { display: grid; gap: 8px; color: #9aa4b2; font-size: 0.9rem; }
    input {
      width: 100%;
      padding: 12px;
      border: 1px solid rgba(190, 199, 210, 0.2);
      border-radius: 6px;
      background: #101318;
      color: #f3f5f7;
      font: inherit;
    }
    button {
      border: 0;
      border-radius: 6px;
      padding: 12px;
      background: #37c6ab;
      color: #06130f;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }
    .error { min-height: 1.2em; margin: 0; color: #ff6b6b; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Custom 3D</h1>
    <label>
      Password
      <input name="password" type="password" inputmode="numeric" autocomplete="current-password" autofocus>
    </label>
    <button type="submit">Open dashboard</button>
    <p class="error">${errorMessage}</p>
  </form>
</body>
</html>`;
}

function requireDashboardAuth(req, res, next) {
  if (isAuthenticated(req)) {
    next();
    return;
  }

  if (req.path === "/orders" || req.path === "/health") {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  res.redirect("/login");
}

function setOAuthCookie(res, state, codeVerifier) {
  const payload = Buffer.from(JSON.stringify({ state, codeVerifier }), "utf8").toString("base64url");
  const secure = config.etsy_redirect_uri && config.etsy_redirect_uri.startsWith("https://");
  const parts = [
    `${OAUTH_COOKIE_NAME}=${encodeURIComponent(payload)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=600"
  ];

  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearOAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${OAUTH_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

function getOAuthCookie(req) {
  const cookie = parseCookies(req)[OAUTH_COOKIE_NAME];
  if (!cookie) return null;

  try {
    return JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
  } catch (error) {
    return null;
  }
}

// ================= DASHBOARD AUTH =================
app.get("/login", (req, res) => {
  if (isAuthenticated(req)) {
    res.redirect("/");
    return;
  }

  res.send(loginPage());
});

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  if (String(req.body?.password || "") === DASHBOARD_PASSWORD) {
    setAuthCookie(res);
    res.redirect("/");
    return;
  }

  res.status(401).send(loginPage("Incorrect password."));
});

app.get("/logout", (req, res) => {
  clearAuthCookie(res);
  res.redirect("/login");
});

app.get("/", requireDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(
  requireDashboardAuth,
  express.static(path.join(__dirname, "public"), {
    index: false
  })
);

// ================= OAUTH START =================
app.get("/oauth", (req, res) => {
  try {
    requireConfig(REQUIRED_CONFIG_FIELDS);

    const state = crypto.randomBytes(24).toString("hex");
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const scope = "transactions_r transactions_w listings_r shops_r";
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.etsy_api_key,
      redirect_uri: config.etsy_redirect_uri,
      scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });

    setOAuthCookie(res, state, codeVerifier);
    console.log("[OAuth] Starting Etsy authorization", { state, redirect_uri: config.etsy_redirect_uri });
    res.redirect(`https://www.etsy.com/oauth/connect?${params.toString()}`);
  } catch (error) {
    console.error("[OAuth] Start failed", error);
    res.status(error.status || 500).send(error.message);
  }
});

// ================= OAUTH CALLBACK =================
app.get("/oauth/callback", async (req, res) => {
  const { code, error, error_description, state } = req.query;

  if (error) {
    clearOAuthCookie(res);
    return res.status(400).send(`OAuth error: ${error}${error_description ? ` - ${error_description}` : ""}`);
  }

  if (!code) {
    clearOAuthCookie(res);
    return res.status(400).send("No OAuth code provided.");
  }

  const oauthCookie = getOAuthCookie(req);
  if (!oauthCookie || !oauthCookie.state || !oauthCookie.codeVerifier) {
    clearOAuthCookie(res);
    return res.status(400).send("Missing OAuth PKCE state. Start again at /oauth.");
  }

  if (!state || state !== oauthCookie.state) {
    clearOAuthCookie(res);
    return res.status(400).send("Invalid OAuth state. Start again at /oauth.");
  }

  try {
    requireConfig(REQUIRED_CONFIG_FIELDS);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.etsy_api_key,
      redirect_uri: config.etsy_redirect_uri,
      code: String(code),
      code_verifier: oauthCookie.codeVerifier
    });

    const tokenResponse = await fetch(ETSY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const tokenData = await readResponseBody(tokenResponse);

    console.log("[OAuth] Token response", {
      status: tokenResponse.status,
      ok: tokenResponse.ok,
      body: {
        ...tokenData,
        access_token: tokenData?.access_token ? redact(tokenData.access_token) : undefined,
        refresh_token: tokenData?.refresh_token ? redact(tokenData.refresh_token) : undefined
      }
    });

    if (!tokenResponse.ok || !tokenData?.access_token) {
      clearOAuthCookie(res);
      return res.status(502).send(`Token error: ${JSON.stringify(tokenData)}`);
    }

    config.etsy_access_token = String(tokenData.access_token).trim();
    config.etsy_refresh_token = tokenData.refresh_token
      ? String(tokenData.refresh_token).trim()
      : config.etsy_refresh_token || null;
    config.etsy_token_type = tokenData.token_type || "Bearer";
    config.etsy_token_expires_at = tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
      : null;

    saveConfig();
    clearOAuthCookie(res);

    console.log("[OAuth] Etsy access token saved.");
    res.send("Etsy connected successfully. You can close this tab and open /orders.");
  } catch (err) {
    clearOAuthCookie(res);
    console.error("[OAuth] Callback failed", err);
    res.status(err.status || 500).send("OAuth failed. Check the server logs for details.");
  }
});

// ================= ETSY API =================
function etsyHeaders() {
  requireAccessToken();

  return {
    Authorization: `Bearer ${config.etsy_access_token}`,
    "x-api-key": etsyApiKeyHeaderValue()
  };
}

async function refreshEtsyAccessToken() {
  normalizeConfig();
  if (!config.etsy_refresh_token) {
    console.log("[OAuth] No Etsy refresh token available.");
    return false;
  }

  try {
    requireConfig(["etsy_api_key"]);

    const tokenResponse = await fetch(ETSY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.etsy_api_key,
        refresh_token: config.etsy_refresh_token
      })
    });
    const tokenData = await readResponseBody(tokenResponse);

    console.log("[OAuth] Refresh response", {
      status: tokenResponse.status,
      ok: tokenResponse.ok,
      body: {
        ...tokenData,
        access_token: tokenData?.access_token ? redact(tokenData.access_token) : undefined,
        refresh_token: tokenData?.refresh_token ? redact(tokenData.refresh_token) : undefined
      }
    });

    if (!tokenResponse.ok || !tokenData?.access_token) {
      return false;
    }

    config.etsy_access_token = String(tokenData.access_token).trim();
    config.etsy_refresh_token = tokenData.refresh_token
      ? String(tokenData.refresh_token).trim()
      : config.etsy_refresh_token;
    config.etsy_token_type = tokenData.token_type || "Bearer";
    config.etsy_token_expires_at = tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
      : null;
    saveConfig();

    return true;
  } catch (err) {
    console.error("[OAuth] Refresh failed", err);
    return false;
  }
}

async function etsyFetch(pathname, options = {}, label = "API") {
  const url = `${ETSY_API_BASE}${pathname}`;
  const headers = {
    ...etsyHeaders(),
    ...(options.headers || {})
  };

  logEtsyRequest(label, url, headers);

  let response = await fetch(url, { ...options, headers });
  let body = await readResponseBody(response);
  logEtsyResponse(label, response, body);

  if (response.status === 401 && body?.error === "invalid_token") {
    const refreshed = await refreshEtsyAccessToken();
    if (refreshed) {
      const retryHeaders = {
        ...etsyHeaders(),
        ...(options.headers || {})
      };

      logEtsyRequest(`${label} retry`, url, retryHeaders);
      response = await fetch(url, { ...options, headers: retryHeaders });
      body = await readResponseBody(response);
      logEtsyResponse(`${label} retry`, response, body);
    }
  }

  if (!response.ok) {
    const error = new Error(body?.error || body?.message || `Etsy request failed with status ${response.status}`);
    error.status = response.status;
    error.etsy = body;
    throw error;
  }

  return body;
}

function getMoneyValue(value) {
  if (!value) return null;

  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (value.amount !== undefined && value.divisor) {
    return Number(value.amount) / Number(value.divisor);
  }

  return null;
}

function getShipByDate(receipt) {
  const transactions = Array.isArray(receipt.transactions) ? receipt.transactions : [];
  const timestamp =
    receipt.expected_ship_date ||
    receipt.max_processing_days_date ||
    transactions.find((transaction) => transaction.expected_ship_date)?.expected_ship_date;
  if (!timestamp) return null;
  const milliseconds = Number(timestamp) * 1000;
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString().split("T")[0];
}

function dateFromUnixSeconds(timestamp) {
  if (!timestamp) return null;
  const milliseconds = Number(timestamp) * 1000;
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function isCurrentMonthIso(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getUTCFullYear() === now.getUTCFullYear() && date.getUTCMonth() === now.getUTCMonth();
}

function looksLikeUspsTrackingNumber(trackingCode) {
  return /^(9[0-9]{19,33}|420[0-9]{5}9[0-9]{19,33})$/.test(String(trackingCode || "").trim());
}

function normalizeCarrier(carrierName, trackingCode) {
  const value = String(carrierName || "").trim().toLowerCase();
  if (looksLikeUspsTrackingNumber(trackingCode)) return "usps";
  if (!value) return "usps";

  if (value.includes("usps") || value.includes("postal")) return "usps";
  if (value.includes("ups")) return "ups";
  if (value.includes("fedex") || value.includes("federal express")) return "fedex";
  if (value.includes("dhl")) return "dhl_express";

  return value.replace(/[^a-z0-9_]+/g, "_");
}

function getTracking(receipt) {
  const shipment = Array.isArray(receipt.shipments) ? receipt.shipments[0] : null;
  const trackingCode = receipt.tracking_code || shipment?.tracking_code || null;
  const carrier = receipt.carrier_name || shipment?.carrier_name || "usps";

  if (!trackingCode) return null;

  return {
    carrier: normalizeCarrier(carrier, trackingCode),
    trackingCode: String(trackingCode).trim()
  };
}

async function getShippoTracking(carrier, trackingCode) {
  normalizeConfig();

  if (!config.shippo_api_key || !trackingCode) {
    return null;
  }

  const cacheKey = `${carrier}:${trackingCode}`;
  const cached = shippoTrackingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const url = `${SHIPPO_API_BASE}/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(trackingCode)}`;
  logShippoRequest(`${carrier} ${trackingCode}`, url);

  const response = await fetch(url, {
    headers: {
      Authorization: `ShippoToken ${config.shippo_api_key}`,
      "SHIPPO-API-VERSION": "2018-02-08"
    }
  });
  const body = await readResponseBody(response);
  logShippoResponse(`${carrier} ${trackingCode}`, response, body);

  if (!response.ok) {
    shippoTrackingCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60 * 1000,
      data: null
    });

    const error = new Error(body?.detail || body?.error || `Shippo tracking failed with status ${response.status}`);
    error.status = response.status;
    error.shippo = body;
    throw error;
  }

  const latestStatus =
    body?.tracking_status ||
    (Array.isArray(body?.tracking_history) ? body.tracking_history[body.tracking_history.length - 1] : null);
  const tracking = {
    status: latestStatus?.status || "UNKNOWN",
    statusDetails: latestStatus?.status_details || null,
    statusDate: latestStatus?.status_date || null,
    eta: body?.eta || null,
    carrier: body?.carrier || carrier,
    trackingNumber: body?.tracking_number || trackingCode
  };

  shippoTrackingCache.set(cacheKey, {
    expiresAt: Date.now() + 15 * 60 * 1000,
    data: tracking
  });

  return tracking;
}

function getCachedShippoTracking(carrier, trackingCode) {
  const cached = shippoTrackingCache.get(`${carrier}:${trackingCode}`);
  return cached && cached.expiresAt > Date.now() ? cached.data : undefined;
}

function statusFromShippo(shippoTracking) {
  const status = String(shippoTracking?.status || "").toUpperCase();

  if (status === "DELIVERED") return "DELIVERED";
  if (status === "TRANSIT") return "IN_TRANSIT";
  if (status === "PRE_TRANSIT") return "SHIPPED";
  if (status === "RETURNED") return "RETURNED";
  if (status === "FAILURE") return "TRACKING_ISSUE";

  return "SHIPPED";
}

async function formatReceipt(receipt, listingImages = {}) {
  const transactions = Array.isArray(receipt.transactions) ? receipt.transactions : [];
  const firstTransaction = transactions[0] || {};
  const listingId = firstTransaction.listing_id;
  const rawStatus = typeof receipt.status === "string" ? receipt.status.toLowerCase() : "";
  const isCanceled = rawStatus === "canceled" || rawStatus === "cancelled" || rawStatus === "refunded";
  const isShipped = Boolean(
    receipt.is_shipped ||
      receipt.was_shipped ||
      rawStatus === "shipped" ||
      rawStatus === "completed" ||
      receipt.tracking_code ||
      receipt.shipments?.length
  );
  const isOpen = !isShipped && !isCanceled && rawStatus !== "completed";
  const tracking = getTracking(receipt);
  const shippedAt = dateFromUnixSeconds(
    receipt.shipped_timestamp ||
      receipt.shipped_date ||
      receipt.shipments?.[0]?.shipment_notification_timestamp
  );
  let shippoTracking = null;
  let status = isShipped ? "SHIPPED" : "OPEN";

  if (rawStatus === "completed" && tracking) {
    try {
      const cachedTracking = getCachedShippoTracking(tracking.carrier, tracking.trackingCode);
      const shouldFetchTracking = cachedTracking !== undefined || isCurrentMonthIso(shippedAt);

      if (shouldFetchTracking) {
        shippoTracking = cachedTracking !== undefined
          ? cachedTracking
          : await getShippoTracking(tracking.carrier, tracking.trackingCode);
        status = statusFromShippo(shippoTracking);
      }
    } catch (error) {
      console.error(`[Shippo ${tracking.carrier} ${tracking.trackingCode}] Failed`, {
        status: error.status,
        body: error.shippo || error.message
      });
      status = "SHIPPED";
    }
  }

  return {
    id: receipt.receipt_id,
    receiptId: receipt.receipt_id,
    orderId: receipt.order_id || null,
    etsyUrl: `https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav&order_id=${receipt.receipt_id}`,
    name: receipt.name || receipt.first_line || "Customer",
    city: receipt.city || "",
    state: receipt.state || "",
    country: receipt.country_iso || receipt.country_name || "",
    product: firstTransaction.title || "Item",
    quantity: firstTransaction.quantity || null,
    image: listingId ? listingImages[listingId] || "" : "",
    createdAt: dateFromUnixSeconds(receipt.create_timestamp || receipt.created_timestamp),
    shipBy: getShipByDate(receipt),
    shippedAt,
    status,
    isOpen,
    isCanceled,
    rawStatus: receipt.status || null,
    tracking: tracking?.trackingCode || null,
    carrier: tracking?.carrier || null,
    trackingStatus: shippoTracking?.status || null,
    trackingDetails: shippoTracking?.statusDetails || null,
    trackingStatusDate: shippoTracking?.statusDate || null,
    eta: shippoTracking?.eta || null,
    total: getMoneyValue(receipt.grandtotal),
    transactions: transactions.map((transaction) => ({
      id: transaction.transaction_id,
      listingId: transaction.listing_id,
      title: transaction.title,
      quantity: transaction.quantity,
      image: transaction.listing_id ? listingImages[transaction.listing_id] || "" : ""
    }))
  };
}

async function getListingImages(receipts) {
  const listingIds = [
    ...new Set(
      receipts
        .flatMap((receipt) => (Array.isArray(receipt.transactions) ? receipt.transactions : []))
        .map((transaction) => transaction.listing_id)
        .filter(Boolean)
    )
  ];
  const listingImages = {};
  const missingListingIds = [];

  for (const listingId of listingIds) {
    if (listingImageCache.has(listingId)) {
      listingImages[listingId] = listingImageCache.get(listingId);
    } else {
      missingListingIds.push(listingId);
    }
  }

  for (const listingId of missingListingIds) {
    try {
      const data = await etsyFetch(`/listings/${listingId}/images`, {}, `Listing ${listingId} images`);
      const image = data?.results?.[0];
      const imageUrl = image?.url_570xN || image?.url_170x135 || image?.url_75x75 || "";
      listingImageCache.set(listingId, imageUrl);
      listingImages[listingId] = imageUrl;
    } catch (error) {
      if (error.status === 429) {
        await sleep(1200);
        try {
          const data = await etsyFetch(`/listings/${listingId}/images`, {}, `Listing ${listingId} images retry`);
          const image = data?.results?.[0];
          const imageUrl = image?.url_570xN || image?.url_170x135 || image?.url_75x75 || "";
          listingImageCache.set(listingId, imageUrl);
          listingImages[listingId] = imageUrl;
        } catch (retryError) {
          listingImageCache.set(listingId, "");
          listingImages[listingId] = "";
          console.error(`[Etsy Listing ${listingId} images] Retry failed`, {
            status: retryError.status,
            body: retryError.etsy || retryError.message
          });
        }
      } else {
        listingImageCache.set(listingId, "");
        listingImages[listingId] = "";
        console.error(`[Etsy Listing ${listingId} images] Failed`, {
          status: error.status,
          body: error.etsy || error.message
        });
      }
    }

    await sleep(220);
  }

  return listingImages;
}

async function getOrders() {
  requireConfig([...REQUIRED_CONFIG_FIELDS, "etsy_access_token"]);

  const params = new URLSearchParams({
    limit: "100"
  });
  const data = await etsyFetch(`/shops/${config.shop_id}/receipts?${params.toString()}`, {}, "Receipts");
  const receipts = Array.isArray(data?.results) ? data.results : [];
  const listingImages = await getListingImages(receipts);

  return mapLimit(receipts, 6, (receipt) => formatReceipt(receipt, listingImages));
}

// ================= API =================
app.get("/orders", async (req, res) => {
  try {
    const orders = await getOrders();
    res.json(orders);
  } catch (error) {
    console.error("[Orders] Failed", {
      status: error.status,
      body: error.etsy || error.message
    });

    res.status(error.status || 500).json({
      error: "Unable to load Etsy orders",
      detail: error.etsy || error.message
    });
  }
});

app.get("/health", (req, res) => {
  normalizeConfig();
  res.json({
    ok: true,
    hasApiKey: Boolean(config.etsy_api_key),
    hasApiSecret: Boolean(config.etsy_api_secret),
    hasAccessToken: Boolean(config.etsy_access_token),
    hasRefreshToken: Boolean(config.etsy_refresh_token),
    shopId: config.shop_id || null
  });
});

// ================= START =================
app.listen(PORT, () => {
  normalizeConfig();
  const missing = missingFields(REQUIRED_CONFIG_FIELDS);

  console.log(`Server running on http://localhost:${PORT}`);
  if (missing.length) {
    console.warn(`Missing config field(s): ${missing.join(", ")}`);
  }
});
