import { z } from "zod";
import type { Page } from "playwright";
import { getPage, designerBaseUrl } from "../designer/session.js";

// These three tools are a different integration than the rest of this
// server: instead of the token-authenticated /pub/v1 REST API, they drive
// the ELMA365 App Designer through a real (headless) browser session,
// authenticated with an admin email/password. That's not a design choice —
// it's the only confirmed-working way to push a widget script edit today.
// The raw PUT /api/widgets/{id} endpoint needs a live session JWT plus a
// per-session lock-hash, both minted client-side; there's no documented way
// to obtain either outside an authenticated Designer tab, and this project
// deliberately does not attempt to extract a live token from one browser
// context for reuse elsewhere. See README.md "Designer tools" for details.

export const getWidgetSchema = z.object({
  namespace: z.string().describe('Namespace + entity code, e.g. "contract_management.contracts"'),
  code: z.string().describe('Widget/form code, e.g. "additional_documents_viewer" or "view_form"'),
});

export const getWidgetHistorySchema = z.object({
  namespace: z.string(),
  code: z.string(),
  size: z.number().int().min(1).max(50).default(10),
});

export const setWidgetScriptSchema = z.object({
  namespace: z.string(),
  code: z.string(),
  scriptType: z.enum(["client", "server"]).describe("Which Скрипты sub-tab to edit"),
  script: z.string().describe("Full replacement source for descriptor.clientScripts / serverScripts"),
  comment: z.string().optional().describe("Version comment; required by the publish dialog if publish=true"),
  publish: z.boolean().default(true).describe("If false, only Save + Validate; leaves it as an unpublished draft"),
  expectedVersion: z
    .number()
    .int()
    .optional()
    .describe(
      "Optimistic-concurrency guard: if given, the call aborts before touching anything when the widget's " +
        "current version doesn't match (someone else published in between). Get the current version first via " +
        "get_widget.",
    ),
});

interface WidgetDescriptor {
  version: number;
  draft: boolean;
  descriptor?: {
    clientScripts?: string;
    serverScripts?: string;
  };
  __updatedAt?: string;
}

async function fetchWidgetJson(page: Page, namespace: string, code: string): Promise<WidgetDescriptor> {
  return page.evaluate(
    async ({ namespace, code }) => {
      const res = await fetch(`/api/widgets/get/${namespace}/${code}`, { credentials: "include" });
      if (!res.ok) throw new Error(`GET widget failed: ${res.status} ${res.statusText}`);
      return res.json();
    },
    { namespace, code },
  );
}

async function fetchHistoryJson(page: Page, namespace: string, code: string, size: number): Promise<unknown> {
  return page.evaluate(
    async ({ namespace, code, size }) => {
      const res = await fetch(`/api/widgets/history/${namespace}/${code}/0/${size}`, { credentials: "include" });
      if (!res.ok) throw new Error(`GET history failed: ${res.status} ${res.statusText}`);
      return res.json();
    },
    { namespace, code, size },
  );
}

async function openDesigner(page: Page, namespace: string, code: string): Promise<void> {
  const url = `${designerBaseUrl()}/admin/interfaces/widget/${namespace}/${code}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Скрипты" }).click();
}

async function pasteIntoEditor(page: Page, scriptType: "client" | "server", code: string): Promise<void> {
  if (scriptType === "server") {
    await page.getByRole("radio", { name: "Сервер" }).check();
  } else {
    await page.getByRole("radio", { name: "Клиент" }).check();
  }

  await page.evaluate((text) => navigator.clipboard.writeText(text), code);

  const line = page.locator(".view-line").first();
  await line.waitFor({ state: "visible", timeout: 10000 });
  const box = await line.boundingBox();
  if (!box) throw new Error("Could not resolve editor line bounding box");
  await page.mouse.click(box.x + 5, box.y + 5);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(300);
  // Monaco virtualizes rendering — only currently-scrolled-into-view lines
  // exist in the DOM. Scroll to the top before reading them back, otherwise
  // a post-paste scroll position can make an unrelated line-1 check fail
  // even though the paste itself landed correctly.
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(200);

  // Integrity check: Monaco's hidden textarea only mirrors a viewport
  // fragment of the model — read the rendered lines instead, and normalize
  // whitespace since Monaco renders indentation with non-breaking spaces.
  const rendered = (await page.locator(".view-lines .view-line").allTextContents()).join("\n");
  const expectedFirstLine = code.split("\n").find((l) => l.trim().length > 0) ?? "";
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  if (expectedFirstLine && !normalize(rendered).includes(normalize(expectedFirstLine))) {
    throw new Error(
      "Paste verification failed: rendered editor content does not contain the expected first non-empty line. "
      + `Expected to find: ${JSON.stringify(expectedFirstLine.trim())}. `
      + `Rendered content was: ${JSON.stringify(rendered.slice(0, 300))}. Aborting before Save.`,
    );
  }
}

export async function handleGetWidget(params: z.infer<typeof getWidgetSchema>): Promise<string> {
  const page = await getPage();
  const json = await fetchWidgetJson(page, params.namespace, params.code);
  return JSON.stringify(
    {
      version: json.version,
      draft: json.draft,
      clientScripts: json.descriptor?.clientScripts,
      serverScripts: json.descriptor?.serverScripts,
      __updatedAt: json.__updatedAt,
    },
    null,
    2,
  );
}

export async function handleGetWidgetHistory(params: z.infer<typeof getWidgetHistorySchema>): Promise<string> {
  const page = await getPage();
  const json = await fetchHistoryJson(page, params.namespace, params.code, params.size);
  return JSON.stringify(json, null, 2);
}

// Waits for the real save/validate/publish network round-trip instead of a
// fixed sleep. All three Designer actions go through a PUT to
// /api/widgets/{id} (not the /lock heartbeat, which fires continuously in
// the background regardless of what the user clicks) — see CLAUDE.md's
// "Widget REST API endpoint map". Falls back to a short grace sleep if no
// matching response shows up in time, rather than hanging indefinitely on
// an endpoint-shape guess that turns out to be wrong.
async function waitForWidgetSave(page: Page, timeoutMs = 8000): Promise<void> {
  try {
    await page.waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().includes("/api/widgets/") && !res.url().endsWith("/lock"),
      { timeout: timeoutMs },
    );
  } catch {
    await page.waitForTimeout(500);
  }
}

export async function handleSetWidgetScript(params: z.infer<typeof setWidgetScriptSchema>): Promise<string> {
  const { namespace, code, scriptType, script, comment, publish, expectedVersion } = params;
  const page = await getPage();

  // Conflict guard: compare against current state before touching anything.
  // Note: GET .../widgets/get returns an unpublished DRAFT's content (with
  // draft:true) when one exists for this session, not necessarily the last
  // published version — so matching content alone isn't reason enough to
  // skip if that draft still needs to be published.
  const before = await fetchWidgetJson(page, namespace, code);

  if (expectedVersion !== undefined && before.version !== expectedVersion) {
    return JSON.stringify({
      success: false,
      reason: `Version conflict: widget is at version ${before.version}, expected ${expectedVersion}. ` +
        "Someone else likely published in between — re-fetch with get_widget before retrying.",
      version: before.version,
      draft: before.draft,
    });
  }

  const currentScript = scriptType === "server" ? before.descriptor?.serverScripts : before.descriptor?.clientScripts;
  const alreadyInDesiredState = currentScript === script && (!publish || !before.draft);
  if (alreadyInDesiredState) {
    return JSON.stringify({
      success: true,
      skipped: true,
      reason: "Script already matches requested content and is not a pending unpublished draft.",
      version: before.version,
      draft: before.draft,
    });
  }

  await openDesigner(page, namespace, code);
  await pasteIntoEditor(page, scriptType, script);

  await page.getByRole("button", { name: "Сохранить" }).click();
  await waitForWidgetSave(page);

  await page.getByRole("button", { name: "check Проверить" }).click();
  await waitForWidgetSave(page);

  // If validation failed, the Опубликовать button stays disabled.
  const publishButton = page.getByRole("button", { name: "arrow_from_bottom Опубликовать" });
  const isDisabled = await publishButton.isDisabled().catch(() => true);
  if (isDisabled) {
    return JSON.stringify({
      success: false,
      reason: "Validation failed or left Опубликовать disabled — check the Designer UI for the error banner.",
    });
  }

  if (!publish) {
    // Confirm the save actually landed rather than trusting the click.
    const savedState = await fetchWidgetJson(page, namespace, code);
    const savedScript = scriptType === "server" ? savedState.descriptor?.serverScripts : savedState.descriptor?.clientScripts;
    if (savedScript !== script) {
      return JSON.stringify({
        success: false,
        reason: "Save did not take effect: re-fetched draft content does not match what was pasted.",
        version: savedState.version,
        draft: savedState.draft,
      });
    }
    return JSON.stringify({ success: true, published: false, version: savedState.version, draft: savedState.draft, note: "Saved + validated only, left as unpublished draft (publish=false)." });
  }

  await publishButton.click();
  // Two nested elements carry role="dialog" here (an outer wrapper plus the
  // real PrimeNG dialog) — match on the accessible name ("Версия <n>") to
  // land on the inner one instead of a Playwright strict-mode violation.
  const dialog = page.getByRole("dialog", { name: /Версия/ });
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  if (comment) {
    await dialog.getByRole("textbox").first().fill(comment);
  }
  await dialog.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await waitForWidgetSave(page);

  // Confirm the publish actually took effect — don't trust the click alone.
  // Compare the full published text and require draft:false, not just a
  // version bump (a version bump alone doesn't prove the *content* landed).
  const after = await fetchWidgetJson(page, namespace, code);
  const publishedScript = scriptType === "server" ? after.descriptor?.serverScripts : after.descriptor?.clientScripts;
  if (after.draft !== false || publishedScript !== script) {
    return JSON.stringify({
      success: false,
      reason: "Publish click completed but re-fetched state doesn't confirm it: " +
        (after.draft !== false ? "widget is still a draft. " : "") +
        (publishedScript !== script ? "published content does not match what was sent." : ""),
      version: after.version,
      draft: after.draft,
    });
  }

  return JSON.stringify({ success: true, published: true, version: after.version, draft: after.draft });
}
