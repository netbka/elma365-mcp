import { chromium, type Browser, type Page } from "playwright";
import { getHostUrl } from "../client.js";

/**
 * One browser + one page per MCP server process. Each server process owns
 * its own in-memory browser profile (nothing persisted to disk), so
 * multiple concurrent MCP server instances (e.g. one per Claude Code
 * session) never fight over a shared Chrome profile the way
 * @playwright/mcp does without --isolated.
 */
let browserPromise: Promise<Browser> | null = null;
let pagePromise: Promise<Page> | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} не задан (ожидается в окружении процесса, из .env)`);
  return value;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: process.env.ELMA365_DESIGNER_HEADLESS !== "false" });
  }
  return browserPromise;
}

export async function getPage(): Promise<Page> {
  if (!pagePromise) {
    pagePromise = (async () => {
      const browser = await getBrowser();
      const context = await browser.newContext();
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const page = await context.newPage();
      await ensureLoggedIn(page);
      return page;
    })();
  }
  return pagePromise;
}

export function designerBaseUrl(): string {
  return getHostUrl();
}

async function ensureLoggedIn(page: Page): Promise<void> {
  const host = designerBaseUrl();
  await page.goto(host + "/", { waitUntil: "domcontentloaded" });

  // The app is a client-rendered SPA: right after domcontentloaded it's
  // blank, and the client-side redirect to /_login (if unauthenticated)
  // only lands a few seconds later — wait for whichever of "login form" /
  // "successful auth check" shows up first instead of checking page.url()
  // immediately, which races the redirect.
  const passwordBox = page.getByPlaceholder("Пароль");
  const loggedInResponse = page
    .waitForResponse((res) => res.url().includes("/api/auth") && res.status() === 200, { timeout: 20000 })
    .catch(() => null);
  await Promise.race([
    passwordBox.waitFor({ state: "visible", timeout: 20000 }),
    loggedInResponse,
  ]);

  if (await passwordBox.isVisible().catch(() => false)) {
    const email = requiredEnv("ELMA365_DESIGNER_EMAIL");
    const password = requiredEnv("ELMA365_DESIGNER_PASSWORD");
    await page.getByPlaceholder("Электронная почта или логин").fill(email);
    await passwordBox.fill(password);
    const authOk = page.waitForResponse(
      (res) => res.url().includes("/guard/login") && res.status() < 400,
      { timeout: 20000 },
    );
    await page.getByRole("button", { name: "Войти в систему" }).click();
    await authOk;
    await passwordBox.waitFor({ state: "hidden", timeout: 20000 });
  }
}

export async function closeDesignerSession(): Promise<void> {
  if (pagePromise) {
    const page = await pagePromise.catch(() => null);
    if (page) await page.close().catch(() => {});
    pagePromise = null;
  }
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser) await browser.close().catch(() => {});
    browserPromise = null;
  }
}
