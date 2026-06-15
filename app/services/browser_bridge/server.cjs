"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const HOST = process.env.GROK_CLOAK_HOST || "127.0.0.1";
const PORT = parseInt(process.env.GROK_CLOAK_PORT || "9081", 10);
const NAV_TIMEOUT = parseInt(process.env.GROK_CLOAK_NAV_TIMEOUT_MS || "45000", 10);
const READY_TIMEOUT = parseInt(process.env.GROK_CLOAK_READY_TIMEOUT_MS || "30000", 10);
const REQUEST_TIMEOUT = parseInt(process.env.GROK_CLOAK_REQUEST_TIMEOUT_MS || "120000", 10);
const PAGE_IDLE_MS = parseInt(process.env.GROK_CLOAK_IDLE_PAGE_MS || "300000", 10);
const MAX_PAGES = parseInt(process.env.GROK_CLOAK_MAX_PAGES || "4", 10);
const HEADLESS = String(process.env.GROK_CLOAK_HEADLESS || "true").toLowerCase() !== "false";
const EXECUTABLE_PATH = (process.env.GROK_CLOAK_EXECUTABLE_PATH || "").trim();
const PROFILE_DIR = (process.env.GROK_CLOAK_PROFILE_DIR || "").trim();
const DIAG_DIR = (process.env.GROK_CLOAK_DIAG_DIR || "").trim();
const PROXY_URL = (process.env.GROK_CLOAK_PROXY_URL || "").trim();
const DEFAULT_USER_AGENT = (process.env.GROK_CLOAK_USER_AGENT || "").trim();
const CF_COOKIES_JSON = (process.env.GROK_CLOAK_CF_COOKIES_JSON || "").trim();
const CF_WAIT_TIMEOUT_MS = parseInt(process.env.GROK_CLOAK_CF_WAIT_TIMEOUT_MS || "90000", 10);

let browser = null;
const pages = new Map();
let lastError = null;
const sessionSnapshots = new Map();
const PROFILE_SLOT_KEY = "__profile__";
const HOME_URL = "https://grok.com/";
const PRIVATE_CHAT_URL = process.env.GROK_CLOAK_PRIVATE_CHAT_URL || HOME_URL;
const PROBE_MESSAGE = process.env.GROK_CLOAK_PROBE_MESSAGE || "你好";
const SESSION_COOKIES_JSON = (process.env.GROK_CLOAK_SESSION_COOKIES_JSON || "").trim();
const CACHED_PROBE_JSON = (process.env.GROK_CLOAK_CACHED_PROBE_JSON || "").trim();
const PROBE_CONSUME_UPSTREAM = String(process.env.GROK_CLOAK_PROBE_CONSUME_UPSTREAM || "false").toLowerCase() === "true";

function parseCookiesJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const name = String(item.name || "").trim();
        const value = String(item.value || "");
        if (!name) return null;
        const domain = String(item.domain || ".grok.com").trim() || ".grok.com";
        const path = String(item.path || "/").trim() || "/";
        const sameSiteRaw = String(item.sameSite || "").trim().toLowerCase();
        let sameSite = undefined;
        if (sameSiteRaw === "lax") sameSite = "Lax";
        else if (sameSiteRaw === "strict") sameSite = "Strict";
        else if (sameSiteRaw === "none" || sameSiteRaw === "no_restriction") sameSite = "None";
        const cookie = {
          name,
          value,
          domain,
          path,
          httpOnly: Boolean(item.httpOnly),
          secure: item.secure !== false,
        };
        if (sameSite) cookie.sameSite = sameSite;
        if (typeof item.expirationDate === "number" && Number.isFinite(item.expirationDate)) {
          cookie.expires = item.expirationDate;
        }
        return cookie;
      })
      .filter(Boolean);
  } catch (error) {
    log(`cookies json parse failed: ${error.message}`);
    return [];
  }
}

function parseInjectedCookies() {
  return parseCookiesJson(SESSION_COOKIES_JSON);
}

function parseCfCookies() {
  return parseCookiesJson(CF_COOKIES_JSON);
}

function mergeCookies(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const cookie of list || []) {
      if (cookie && cookie.name) {
        map.set(cookie.name, cookie);
      }
    }
  }
  return [...map.values()];
}

function buildProxyOption() {
  if (!PROXY_URL) return undefined;
  return { server: PROXY_URL };
}

function parseCachedProbe() {
  if (!CACHED_PROBE_JSON) return {};
  try {
    const parsed = JSON.parse(CACHED_PROBE_JSON);
    if (!parsed || typeof parsed !== "object") return {};
    return {
      user_agent: String(parsed.user_agent || "").trim(),
      x_statsig_id: String(parsed.x_statsig_id || "").trim(),
      request_headers:
        parsed.request_headers && typeof parsed.request_headers === "object"
          ? parsed.request_headers
          : {},
    };
  } catch (error) {
    log(`cached probe json parse failed: ${error.message}`);
    return {};
  }
}

const CACHED_PROBE = parseCachedProbe();

function getEffectiveUserAgent() {
  return DEFAULT_USER_AGENT || CACHED_PROBE.user_agent || "";
}

function buildTemporaryProbePayload(basePayload = {}, pageInfo = {}) {
  const viewport = pageInfo.viewport || {};
  const screen = pageInfo.screen || {};
  return {
    temporary: true,
    message: PROBE_MESSAGE,
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: true,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: true,
    imageGenerationCount: 2,
    forceConcise: false,
    enableSideBySide: true,
    sendFinalMetadata: true,
    disableTextFollowUps: false,
    responseMetadata: {},
    disableMemory: false,
    forceSideBySide: false,
    isAsyncChat: false,
    disableSelfHarmShortCircuit: false,
    collectionIds: [],
    disabledConnectorIds: [],
    deviceEnvInfo: {
      darkModeEnabled: Boolean(pageInfo.darkModeEnabled),
      devicePixelRatio: pageInfo.devicePixelRatio || 1,
      screenWidth: screen.width || 1600,
      screenHeight: screen.height || 1000,
      viewportWidth: viewport.width || 1600,
      viewportHeight: viewport.height || 1000,
    },
    modeId: "auto",
    linkQuery: false,
    ...basePayload,
    temporary: true,
    message: PROBE_MESSAGE,
  };
}

class BridgeError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
}

function log(message) {
  console.log(`[cloakbridge] ${new Date().toISOString()} ${message}`);
}

function appChatRequestHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("x-") ||
      lower.startsWith("sec-ch-") ||
      lower === "baggage" ||
      lower === "accept-language" ||
      lower === "priority"
    ) {
      result[lower] = value;
    }
  }
  return result;
}

function isConversationSubmitUrl(url) {
  return (
    url.includes("/rest/app-chat/conversations/new") ||
    /\/rest\/app-chat\/conversations\/[^/]+\/responses(?:\?|$)/.test(url)
  );
}

function isNewConversationSubmitUrl(url) {
  return url.includes("/rest/app-chat/conversations/new");
}

function isResponseSubmitUrl(url) {
  return /\/rest\/app-chat\/conversations\/[^/]+\/responses(?:\?|$)/.test(url);
}

function extractSsoFromCookies(cookies) {
  const ssoCookie = (cookies || []).find((item) => item.name === "sso-rw" || item.name === "sso");
  return ssoCookie ? String(ssoCookie.value || "").trim() : "";
}

function snapshotKeys(slot) {
  const keys = [slot.key || PROFILE_SLOT_KEY];
  if (slot.sso && !keys.includes(slot.sso)) {
    keys.push(slot.sso);
  }
  return keys;
}

async function captureProbeSnapshot(slot, request, payload) {
  const headers = appChatRequestHeaders(await request.allHeaders());
  const previous =
    sessionSnapshots.get(slot.sso || "") || sessionSnapshots.get(slot.key || PROFILE_SLOT_KEY) || {};
  const statsig = headers["x-statsig-id"] || previous.x_statsig_id || "";
  const snapshot = {
    ...previous,
    sso: slot.sso || "",
    request_headers: headers,
    x_statsig_id: statsig,
    captured_at: new Date().toISOString(),
  };
  for (const snapshotKey of snapshotKeys(slot)) {
    sessionSnapshots.set(snapshotKey, snapshot);
  }
  log(
    `captured unconsumed probe headers url=https://grok.com/rest/app-chat/conversations/new temporary=${
      payload?.temporary === true ? "yes" : "no"
    } statsig=${statsig ? "yes" : "no"} keys=${Object.keys(headers).join(",")}`
  );
  return snapshot;
}

function ensureProfileDir() {
  if (!PROFILE_DIR) return "";
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return PROFILE_DIR;
}

function ensureDiagDir() {
  if (!DIAG_DIR) return "";
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  return DIAG_DIR;
}

async function captureDiagnostics(page, label) {
  try {
    const info = await page.evaluate(() => ({
      href: location.href,
      title: document.title || "",
      body: (document.body?.innerText || "").slice(0, 1200),
    }));
    log(
      `diagnostics label=${label} href=${info.href} title=${JSON.stringify(info.title)} body=${JSON.stringify(info.body)}`
    );
  } catch (error) {
    log(`diagnostics label=${label} eval_failed=${error.message}`);
  }

  const dir = ensureDiagDir();
  if (!dir) return;
  const file = path.join(dir, `${Date.now()}-${label}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    log(`diagnostics screenshot=${file}`);
  } catch (error) {
    log(`diagnostics screenshot_failed=${error.message}`);
  }
}

async function ensureBrowser() {
  if (browser) {
    if (typeof browser.isConnected === "function") {
      if (browser.isConnected()) return browser;
    } else {
      return browser;
    }
  }

  const launchOptions = {
    headless: HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  };
  const proxy = buildProxyOption();
  if (proxy) {
    launchOptions.proxy = proxy;
  }
  const effectiveUserAgent = getEffectiveUserAgent();
  if (EXECUTABLE_PATH) {
    launchOptions.executablePath = EXECUTABLE_PATH;
  }
  if (effectiveUserAgent) {
    launchOptions.userAgent = effectiveUserAgent;
  }

  const userDataDir = ensureProfileDir();
  if (userDataDir) {
    browser = await chromium.launchPersistentContext(userDataDir, launchOptions);
    browser.on("close", () => {
      browser = null;
      pages.clear();
    });
    return browser;
  }

  const launched = await chromium.launch(launchOptions);
  launched.on("disconnected", () => {
    browser = null;
    pages.clear();
  });
  browser = launched;
  return browser;
}

async function createContextWithCookies(playwrightBrowser, sso) {
  const injectedCookies = mergeCookies(parseCfCookies(), parseInjectedCookies());
  const effectiveUserAgent = getEffectiveUserAgent();
  const authCookies = [];
  if (sso) {
    authCookies.push(
      { name: "sso", value: sso, domain: ".grok.com", path: "/" },
      { name: "sso-rw", value: sso, domain: ".grok.com", path: "/" }
    );
  }
  const cookiesToAdd = injectedCookies.length ? injectedCookies : authCookies;
  const isPersistentContext =
    typeof playwrightBrowser.newPage === "function" &&
    typeof playwrightBrowser.cookies === "function" &&
    typeof playwrightBrowser.newContext !== "function";

  if (isPersistentContext) {
    if (cookiesToAdd.length) {
      await playwrightBrowser.addCookies(cookiesToAdd);
    }
    return { context: playwrightBrowser, page: await playwrightBrowser.newPage() };
  }

  const contextProxy = buildProxyOption();
  const context = await playwrightBrowser.newContext({
    viewport: { width: 1600, height: 1000 },
    ...(effectiveUserAgent ? { userAgent: effectiveUserAgent } : {}),
    ...(contextProxy ? { proxy: contextProxy } : {}),
  });
  if (cookiesToAdd.length) {
    await context.addCookies(cookiesToAdd);
  }
  return { context, page: await context.newPage() };
}

async function isCloudflareChallenge(page) {
  try {
    return await page.evaluate(() => {
      const title = document.title || "";
      const body = document.body?.innerText || "";
      const html = document.body?.innerHTML || "";
      return (
        /just a moment/i.test(title) ||
        /checking your browser/i.test(body) ||
        /cf-browser-verification/i.test(html) ||
        /challenge-platform/i.test(html)
      );
    });
  } catch (_) {
    return false;
  }
}

async function waitForCloudflare(page, label = "page") {
  const deadline = Date.now() + CF_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const blocked = await isCloudflareChallenge(page);
    if (!blocked) {
      const hasInput = await page
        .locator("textarea, [contenteditable='true']")
        .first()
        .isVisible({ timeout: 1500 })
        .catch(() => false);
      if (hasInput) {
        log(`${label}: cloudflare challenge cleared`);
        return true;
      }
    }
    await page.waitForTimeout(1000);
  }
  log(`${label}: cloudflare wait timed out after ${CF_WAIT_TIMEOUT_MS}ms`);
  return false;
}

async function applyProbeCookies(context, cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return false;
  const normalized = cookies.filter((item) => item && item.name);
  if (!normalized.length) return false;
  await context.addCookies(normalized);
  log(`applied probe cookies count=${normalized.length}`);
  return true;
}

async function prepareSlot(slot) {
  const { page } = slot;
  await page.goto(HOME_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });
  await page.waitForLoadState("networkidle", { timeout: READY_TIMEOUT }).catch(() => {});
  await waitForCloudflare(page, "prepare-slot").catch(() => {});

  const cookies = await slot.context.cookies("https://grok.com");
  const cookieSso = extractSsoFromCookies(cookies);
  if (cookieSso) {
    slot.sso = cookieSso;
  }
  const hasSession = cookies.some(
    (item) => item.name === "x-userid" || item.name === "sso" || item.name === "sso-rw"
  );
  let hasUsableChat = false;
  if (!hasSession) {
    hasUsableChat = await page
      .locator("textarea, [contenteditable='true']")
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
  }
  if (!hasSession && !hasUsableChat) {
    await captureDiagnostics(page, "prepare-slot-no-session");
    throw new BridgeError("sso_unavailable", "SSO cookie did not establish a Grok session", 401);
  }

  slot.ready = true;
  slot.lastUsed = Date.now();
  await refreshSessionSnapshot(slot).catch(() => {});
}

async function hasInaccessiblePrivateLink(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return (
        location.href.includes("/c#") &&
        /你需要访问权限|私人对话链接|请求访问权限|Request access|private conversation link/i.test(text)
      );
    });
  } catch (_) {
    return false;
  }
}

async function navigateToUsableChat(page, label) {
  const target = PRIVATE_CHAT_URL && PRIVATE_CHAT_URL !== "https://grok.com/c#private"
    ? PRIVATE_CHAT_URL
    : HOME_URL;
  await page.goto(target, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });
  await page.waitForLoadState("networkidle", { timeout: READY_TIMEOUT }).catch(() => {});
  const cfReady = await waitForCloudflare(page, label).catch(() => false);
  if (!cfReady && (await isCloudflareChallenge(page))) {
    await captureDiagnostics(page, `${label}-cloudflare-blocked`);
    throw new BridgeError(
      "cloudflare_blocked",
      "Cloudflare challenge not cleared before chat probe",
      403
    );
  }
  await dismissCookieBanner(page);

  if (await hasInaccessiblePrivateLink(page)) {
    log(`${label}: private link inaccessible, returning to Grok home`);
    await page.goto(HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForLoadState("networkidle", { timeout: READY_TIMEOUT }).catch(() => {});
    await dismissCookieBanner(page);
  }

  const newChatCandidates = [
    page.locator('a[href="/"], a[href="/?new=1"]').first(),
    page.locator('button:has-text("新建聊天")').first(),
    page.locator('button:has-text("开始新聊天")').first(),
    page.locator('button:has-text("New chat")').first(),
  ];
  for (const locator of newChatCandidates) {
    try {
      if (await locator.isVisible({ timeout: 750 }).catch(() => false)) {
        await locator.click({ timeout: 2500 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        break;
      }
    } catch (_) {}
  }

  const input = page.locator("textarea, [contenteditable='true']").first();
  try {
    await input.waitFor({ state: "visible", timeout: READY_TIMEOUT });
    return input;
  } catch (error) {
    await captureDiagnostics(page, `${label}-no-input`);
    throw new BridgeError("input_unavailable", `Chat input not available for ${label}: ${error.message}`, 502);
  }
}


async function prepareUsableChat(page, label, options = {}) {
  const skipInitialGoto = options.skipInitialGoto === true;
  if (skipInitialGoto) {
    await dismissCookieBanner(page).catch(() => {});
    const quickInput = page.locator("textarea, [contenteditable='true']").first();
    if (await quickInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      log(`${label}: reusing prepared Grok home page, skip second goto`);
      try {
        await quickInput.waitFor({ state: "visible", timeout: READY_TIMEOUT });
        return quickInput;
      } catch (error) {
        log(`${label}: prepared page input wait failed, fallback to full navigation`);
      }
    } else {
      log(`${label}: prepared page has no visible chat input, fallback to full navigation`);
    }
  }
  return navigateToUsableChat(page, label);
}

async function readComposerText(input) {
  try {
    return await input.evaluate((node) => {
      if (!node) return "";
      if (typeof node.value === "string") {
        return node.value;
      }
      return node.textContent || node.innerText || "";
    });
  } catch (_) {
    return "";
  }
}

async function fillComposerWithProbe(page, input, message, label) {
  await input.click({ timeout: 5000 }).catch(async () => {
    await input.click({ timeout: 5000, force: true });
  });

  try {
    await input.fill("");
  } catch (_) {}
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(message || ""), { delay: 5 });

  let actual = (await readComposerText(input)).trim();
  if (actual === String(message || "").trim()) {
    log(`${label}: probe message filled and verified on first attempt`);
    return true;
  }

  log(
    `${label}: probe message verify failed on first attempt expected=${JSON.stringify(
      String(message || "")
    )} actual=${JSON.stringify(actual)}`
  );

  try {
    await input.fill(String(message || ""));
  } catch (_) {
    await input.click({ timeout: 5000, force: true }).catch(() => {});
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await page.keyboard.type(String(message || ""), { delay: 20 }).catch(() => {});
  }

  actual = (await readComposerText(input)).trim();
  if (actual === String(message || "").trim()) {
    log(`${label}: probe message filled and verified on second attempt`);
    return true;
  }

  log(
    `${label}: probe message verify failed on second attempt expected=${JSON.stringify(
      String(message || "")
    )} actual=${JSON.stringify(actual)}`
  );
  return false;
}

async function submitProbeFromReadyPage(page, input, label) {
  const sendBtn = page
    .locator('button[type="submit"], button[aria-label*="Send"], button[aria-label*="send"]')
    .first();

  const requestPromise = page.waitForRequest(
    (request) => isConversationSubmitUrl(request.url()) && request.method() === "POST",
    { timeout: 8000 }
  );
  const clearedPromise = page
    .waitForFunction(
      (node) => {
        if (!node) return false;
        const value = typeof node.value === "string" ? node.value : node.textContent || node.innerText || "";
        return !String(value || "").trim();
      },
      await input.elementHandle(),
      { timeout: 8000 }
    )
    .catch(() => null);

  if (await sendBtn.isVisible().catch(() => false)) {
    await sendBtn.click({ timeout: 5000 }).catch(async () => {
      await page.keyboard.press("Enter");
    });
  } else {
    await page.keyboard.press("Enter");
  }

  const requestMatched = await requestPromise
    .then(() => true)
    .catch(() => false);
  const composerCleared = (await clearedPromise) !== null;

  if (requestMatched) {
    log(`${label}: probe submit triggered request`);
    return true;
  }
  if (composerCleared) {
    log(`${label}: probe submit cleared composer without captured request`);
    return true;
  }

  log(`${label}: probe submit did not trigger request or clear composer`);
  return false;
}

async function refreshSessionSnapshot(slot) {
  const { page, context } = slot;
  const cookies = await context.cookies("https://grok.com");
  const cookieSso = extractSsoFromCookies(cookies);
  if (cookieSso) {
    slot.sso = cookieSso;
  }
  const cookieHeader = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  const ua = await page.evaluate(() => navigator.userAgent || "");
  const previous =
    sessionSnapshots.get(slot.sso || "") || sessionSnapshots.get(slot.key || PROFILE_SLOT_KEY) || {};
  const statsig = await page.evaluate(() => {
    const keys = [
      "x-statsig-id",
      "statsigId",
      "statsig_id",
      "STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4",
    ];
    for (const key of keys) {
      try {
        const value = window.localStorage.getItem(key);
        if (value) return value;
      } catch (_) {}
    }
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key) continue;
        if (key.toLowerCase().includes("statsig")) {
          const value = window.localStorage.getItem(key);
          if (value) return value;
        }
      }
    } catch (_) {}
    return "";
  });
  const snapshot = {
    ...previous,
    sso: slot.sso || "",
    cookie_header: cookieHeader,
    user_agent: ua,
    x_statsig_id: previous.x_statsig_id || statsig,
    captured_at: new Date().toISOString(),
  };
  for (const key of snapshotKeys(slot)) {
    sessionSnapshots.set(key, snapshot);
  }
}

function hasCapturedAppChatHeaders(sso) {
  const snapshot = sessionSnapshots.get(sso) || {};
  return Boolean(
    snapshot.x_statsig_id &&
      snapshot.request_headers &&
      Object.keys(snapshot.request_headers).length > 0
  );
}

async function dismissCookieBanner(page) {
  const candidates = [
    page.locator('button:has-text("全部拒绝")').first(),
    page.locator('button:has-text("Reject All")').first(),
    page.locator('button:has-text("Reject all")').first(),
    page.locator('button:has-text("仅接受必要")').first(),
  ];
  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
        await locator.click({ timeout: 3000 });
        log("cookie banner dismissed");
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function enableTemporaryMode(page, desiredTemporary) {
  if (!desiredTemporary) return false;

  const candidates = [
    page.locator('button[aria-label*="Temporary"]').first(),
    page.locator('button:has-text("Temporary")').first(),
    page.locator('button:has-text("临时")').first(),
    page.locator('[role="switch"][aria-label*="Temporary"]').first(),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
        const pressed = await locator.getAttribute("aria-pressed").catch(() => null);
        const checked = await locator.getAttribute("aria-checked").catch(() => null);
        if (pressed === "true" || checked === "true") {
          log("temporary mode already enabled");
          return true;
        }
        await locator.click({ timeout: 3000 });
        log("temporary mode toggled on");
        return true;
      }
    } catch (_) {}
  }

  log("temporary mode toggle not found");
  return false;
}

async function destroySlot(key) {
  const slot = pages.get(key);
  if (!slot) return;
  pages.delete(key);
  try {
    if (slot.context && slot.context !== browser) {
      await slot.context.close();
    } else if (slot.page) {
      await slot.page.close();
    }
  } catch (_) {}
}

async function getSlot(sso) {
  const key = sso || PROFILE_SLOT_KEY;
  let slot = pages.get(key);
  if (slot && slot.ready && !slot.busy) {
    slot.lastUsed = Date.now();
    return slot;
  }
  if (slot) {
    await destroySlot(key);
  }

  if (pages.size >= MAX_PAGES) {
    const oldest = [...pages.entries()]
      .filter(([, value]) => !value.busy)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) {
      await destroySlot(oldest[0]);
    }
  }

  const b = await ensureBrowser();
  const { context, page } = await createContextWithCookies(b, sso);
  slot = {
    key,
    sso,
    context,
    page,
    ready: false,
    busy: false,
    lastUsed: Date.now(),
  };
  const rewriteProbeRoute = async (route) => {
    const request = route.request();
    if (!slot.probeActive || request.method() !== "POST") {
      await route.continue();
      return;
    }
    let basePayload = {};
    try {
      basePayload = request.postDataJSON();
    } catch (_) {}
    const payload = buildTemporaryProbePayload(basePayload, slot.probePageInfo || {});
    const targetUrl = "https://grok.com/rest/app-chat/conversations/new";
    log(
      `rewriting probe conversation payload temporary=yes target=/new source=${
        isResponseSubmitUrl(request.url()) ? "/responses" : "/new"
      }`
    );
    await captureProbeSnapshot(slot, request, payload);
    if (!PROBE_CONSUME_UPSTREAM) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body:
          '{"result":{"conversation":{"conversationId":"probe","temporary":true}}}\n' +
          '{"result":{"response":{"modelResponse":{"responseId":"probe","message":"","sender":"ASSISTANT","partial":false}}}}\n',
      });
      return;
    }
    await route.continue({
      url: targetUrl,
      headers: {
        ...request.headers(),
        "content-type": "application/json",
      },
      postData: JSON.stringify(payload),
    });
  };
  await page.route("**/rest/app-chat/conversations/new*", rewriteProbeRoute);
  await page.route("**/rest/app-chat/conversations/*/responses*", rewriteProbeRoute);
  page.on("request", async (request) => {
    try {
      if (!isConversationSubmitUrl(request.url()) || request.method() !== "POST") {
        return;
      }
      const headers = appChatRequestHeaders(await request.allHeaders());
      let temporary = null;
      try {
        const body = request.postDataJSON();
        temporary = Boolean(body && body.temporary);
      } catch (_) {}
      if (slot.probeActive && (!isNewConversationSubmitUrl(request.url()) || temporary !== true)) {
        log(
          `ignored non-temporary probe capture url=${request.url()} temporary=${
            temporary === null ? "-" : temporary ? "yes" : "no"
          }`
        );
        return;
      }
      const previous =
        sessionSnapshots.get(slot.sso || "") || sessionSnapshots.get(slot.key || PROFILE_SLOT_KEY) || {};
      const statsig = headers["x-statsig-id"] || previous.x_statsig_id || "";
      const snapshot = {
        ...previous,
        sso: slot.sso || "",
        request_headers: headers,
        x_statsig_id: statsig,
        captured_at: new Date().toISOString(),
      };
      for (const snapshotKey of snapshotKeys(slot)) {
        sessionSnapshots.set(snapshotKey, snapshot);
      }
      log(
        `captured app-chat headers url=${request.url()} temporary=${
          temporary === null ? "-" : temporary ? "yes" : "no"
        } statsig=${statsig ? "yes" : "no"} keys=${Object.keys(headers).join(",")}`
      );
    } catch (error) {
      log(`capture request headers failed: ${error.message}`);
    }
  });
  pages.set(key, slot);
  await prepareSlot(slot);
  return slot;
}

async function submitThroughUi(slot, payload, conversationId) {
  const { page } = slot;
  const targetPattern = conversationId
    ? `/rest/app-chat/conversations/${conversationId}/responses`
    : "/rest/app-chat/conversations/new";
  const message = String(payload.message || "");

  const input = await navigateToUsableChat(page, "submit");
  await enableTemporaryMode(page, payload.temporary === true);
  await input.click({ timeout: 5000 });

  try {
    await input.fill("");
  } catch (_) {}

  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(message || ""), { delay: 10 });

  const sendStartedAt = Date.now();
  const responsePromise = page.waitForResponse(
    (resp) => {
      if (!resp.url().includes(targetPattern) || resp.request().method() !== "POST") {
        return false;
      }
      return resp.request().timing().startTime * 1000 >= sendStartedAt - 2000;
    },
    { timeout: REQUEST_TIMEOUT }
  );

  const sendBtn = page
    .locator('button[type="submit"], button[aria-label*="Send"], button[aria-label*="send"]')
    .first();

  if (await sendBtn.isVisible().catch(() => false)) {
    await sendBtn.click({ timeout: 5000 }).catch(async () => {
      await page.keyboard.press("Enter");
    });
  } else {
    await page.keyboard.press("Enter");
  }

  const response = await responsePromise;
  const status = response.status();
  const body = await response.text();
  log(
    `upstream status=${status} conversation=${conversationId || "-"} url=${response.url()} body=${JSON.stringify(
      String(body || "").slice(0, 400)
    )}`
  );
  return { status, body };
}

async function waitForCapturedHeaders(sso, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasCapturedAppChatHeaders(sso)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return hasCapturedAppChatHeaders(sso);
}

async function probeAppChatHeaders(slot, force = false, credentials = {}) {
  if (!force && hasCapturedAppChatHeaders(slot.sso)) {
    return sessionSnapshots.get(slot.sso) || {};
  }
  if (force) {
    for (const key of snapshotKeys(slot)) {
      const previous = sessionSnapshots.get(key) || {};
      sessionSnapshots.set(key, {
        ...previous,
        request_headers: {},
        x_statsig_id: "",
        captured_at: new Date().toISOString(),
      });
    }
  }

  const { page, context } = slot;
  const freshCookies = Array.isArray(credentials.cookies) ? credentials.cookies : [];
  const injectedFreshCookies = await applyProbeCookies(context, freshCookies);
  let input = await prepareUsableChat(page, "probe", { skipInitialGoto: !injectedFreshCookies });
  let attemptedReuse = !injectedFreshCookies;

  while (true) {
    await enableTemporaryMode(page, true);
    slot.probePageInfo = await page
      .evaluate(() => ({
        darkModeEnabled: window.matchMedia?.("(prefers-color-scheme: dark)")?.matches || false,
        devicePixelRatio: window.devicePixelRatio || 1,
        screen: {
          width: window.screen?.width || 0,
          height: window.screen?.height || 0,
        },
        viewport: {
          width: window.innerWidth || 0,
          height: window.innerHeight || 0,
        },
      }))
      .catch(() => ({}));
    slot.probeActive = true;

    try {
      const filled = await fillComposerWithProbe(page, input, PROBE_MESSAGE, "probe");
      if (!filled) {
        if (attemptedReuse) {
          log("probe: prepared page composer state is unstable, fallback to full navigation");
          input = await navigateToUsableChat(page, "probe-fallback");
          attemptedReuse = false;
          continue;
        }
        throw new BridgeError("probe_input_unstable", "Probe composer did not accept full message", 502);
      }

      const submitted = await submitProbeFromReadyPage(page, input, "probe");
      if (!submitted) {
        if (attemptedReuse) {
          log("probe: prepared page submit not triggered, fallback to full navigation");
          input = await navigateToUsableChat(page, "probe-fallback");
          attemptedReuse = false;
          continue;
        }
        throw new BridgeError("probe_submit_unavailable", "Probe submit action did not trigger request", 502);
      }

      await waitForCapturedHeaders(slot.sso, 5000);
      await refreshSessionSnapshot(slot).catch(() => {});
      break;
    } finally {
      slot.probeActive = false;
      slot.probePageInfo = null;
    }
  }

  const snapshot = sessionSnapshots.get(slot.sso) || {};
  if (!hasCapturedAppChatHeaders(slot.sso)) {
    log("probe completed but app-chat headers were not captured");
  } else {
    log(
      `probe captured app-chat headers statsig=${snapshot.x_statsig_id ? "yes" : "no"} keys=${Object.keys(
        snapshot.request_headers || {}
      ).join(",")}`
    );
  }
  return snapshot;
}

async function sendMessage(sso, payload, conversationId) {
  const slot = await getSlot(sso);
  if (slot.busy) {
    throw new BridgeError("page_busy", "Bridge page busy", 429);
  }
  if (!payload || typeof payload.message !== "string") {
    throw new BridgeError("invalid_request", "Payload.message is required for UI bridge", 400);
  }

  slot.busy = true;
  slot.lastUsed = Date.now();
  try {
    const result = await Promise.race([
      submitThroughUi(slot, payload, conversationId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new BridgeError("request_timeout", "Bridge request timeout", 504)), REQUEST_TIMEOUT)
      ),
    ]);
    await refreshSessionSnapshot(slot).catch(() => {});
    return result;
  } finally {
    slot.busy = false;
    slot.lastUsed = Date.now();
  }
}

setInterval(async () => {
  const now = Date.now();
  for (const [key, slot] of pages.entries()) {
    if (!slot.busy && now - slot.lastUsed > PAGE_IDLE_MS) {
      await destroySlot(key);
    }
  }
}, 60000);

function respond(res, status, payload, contentType = "application/json") {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return respond(res, 200, {
      status: lastError ? "degraded" : "ok",
      pages: pages.size,
      last_error: lastError,
    });
  }

  if (req.method === "GET" && req.url.startsWith("/api/session")) {
    const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
    const sso = (parsed.searchParams.get("sso") || "").trim();
    const key = sso || PROFILE_SLOT_KEY;
    let slot = pages.get(key);
    if (!slot) {
      try {
        slot = await getSlot(sso);
      } catch (error) {
        const bridgeError =
          error instanceof BridgeError
            ? error
            : new BridgeError("bridge_failed", error.message || "Bridge failed", 502);
        return respond(res, bridgeError.status, {
          code: bridgeError.code,
          error: bridgeError.message,
        });
      }
    }
    await refreshSessionSnapshot(slot).catch(() => {});
    return respond(res, 200, sessionSnapshots.get(slot.sso || "") || sessionSnapshots.get(key) || {});
  }

  if (req.method === "POST" && req.url === "/api/probe") {
    try {
      const body = await readJson(req);
      const sso = typeof body.sso === "string" ? body.sso.trim() : "";
      const force = body.force === true;
      const credentials = {
        cookies: Array.isArray(body.cookies) ? body.cookies : [],
      };
      const slot = await getSlot(sso);
      if (slot.busy) {
        throw new BridgeError("page_busy", "Bridge page busy", 429);
      }
      slot.busy = true;
      slot.lastUsed = Date.now();
      try {
        const snapshot = await probeAppChatHeaders(slot, force, credentials);
        lastError = null;
        return respond(res, 200, snapshot || {});
      } finally {
        slot.busy = false;
        slot.lastUsed = Date.now();
      }
    } catch (error) {
      const bridgeError =
        error instanceof BridgeError
          ? error
          : new BridgeError("bridge_failed", error.message || "Bridge failed", 502);
      lastError = { code: bridgeError.code, message: bridgeError.message };
      log(`probe failed: ${bridgeError.code} ${bridgeError.message}`);
      return respond(res, bridgeError.status, {
        code: bridgeError.code,
        error: bridgeError.message,
      });
    }
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    try {
      const body = await readJson(req);
      const sso = typeof body.sso === "string" ? body.sso.trim() : "";
      const payload = body.payload;
      const conversationId =
        typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";

      if (!sso) {
        throw new BridgeError("invalid_request", "Missing sso", 400);
      }
      if (!payload || typeof payload !== "object") {
        throw new BridgeError("invalid_request", "Missing payload", 400);
      }

      const result = await sendMessage(sso, payload, conversationId);
      if (result.status >= 400) {
        lastError = { code: "upstream_error", status: result.status };
        log(`upstream_error status=${result.status} body=${JSON.stringify(String(result.body || "").slice(0, 400))}`);
        return respond(res, result.status, {
          code: "upstream_error",
          error: `Upstream returned ${result.status}`,
          body: result.body,
        });
      }

      lastError = null;
      return respond(res, 200, result.body, "text/plain; charset=utf-8");
    } catch (error) {
      const bridgeError =
        error instanceof BridgeError
          ? error
          : new BridgeError("bridge_failed", error.message || "Bridge failed", 502);
      lastError = { code: bridgeError.code, message: bridgeError.message };
      log(`request failed: ${bridgeError.code} ${bridgeError.message}`);
      return respond(res, bridgeError.status, {
        code: bridgeError.code,
        error: bridgeError.message,
      });
    }
  }

  return respond(res, 404, { code: "not_found", error: "Not found" });
});

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}`);
});
