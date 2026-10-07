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
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0)
    .describe("History row offset; request later pages explicitly. A full page does not prove complete history."),
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
  __id: string;
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

async function fetchHistoryJson(page: Page, namespace: string, code: string, offset: number, size: number): Promise<unknown> {
  return page.evaluate(
    async ({ namespace, code, offset, size }) => {
      const res = await fetch(`/api/widgets/history/${encodeURIComponent(namespace)}/${encodeURIComponent(code)}/${offset}/${size}`, { credentials: "include" });
      if (!res.ok) throw new Error(`GET history failed: ${res.status} ${res.statusText}`);
      return res.json();
    },
    { namespace, code, offset, size },
  );
}

async function openDesigner(page: Page, namespace: string, code: string): Promise<void> {
  const url = `${designerBaseUrl()}/admin/interfaces/widget/${namespace}/${code}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Скрипты" }).click();
}

// The Клиент/Сервер switch on the Скрипты tab is a pair of radios on ELMA365
// 2025.4 and a pair of aria-pressed toggle buttons (inside a group) on
// 2025.10 — observed live on dev2 after its 2025.4.107 → 2025.10.97 upgrade.
// Support both so one build works against either server generation.
async function selectScriptKind(page: Page, scriptType: "client" | "server"): Promise<void> {
  const label = scriptType === "server" ? "Сервер" : "Клиент";
  const radio = page.getByRole("radio", { name: label });
  if ((await radio.count()) > 0) {
    await radio.check();
    return;
  }
  const toggle = page.getByRole("button", { name: label, exact: true }).first();
  await toggle.waitFor({ state: "visible", timeout: 10000 });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
}

async function pasteIntoEditor(page: Page, scriptType: "client" | "server", code: string): Promise<void> {
  // The editor (and the switch next to it) only exists once the Скрипты tab
  // has rendered — wait for a Monaco line before looking for the switch.
  const line = page.locator(".view-line").first();
  await line.waitFor({ state: "visible", timeout: 10000 });
  await selectScriptKind(page, scriptType);
  await line.waitFor({ state: "visible", timeout: 10000 });

  await page.evaluate((text) => navigator.clipboard.writeText(text), code);

  // Monaco re-creates .view-line nodes while it (re)renders, so a single
  // boundingBox() on a line can come back null right after a tab switch.
  // The .view-lines container is stable; clicking its top-left focuses the
  // editor just the same. The real <textarea> is covered by an overlay and
  // won't take a normal element click.
  let box: { x: number; y: number } | null = null;
  for (let attempt = 0; attempt < 10 && !box; attempt++) {
    box = await page.locator(".view-lines").first().boundingBox();
    if (!box) await page.waitForTimeout(300);
  }
  if (!box) throw new Error("Could not resolve editor bounding box");
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
  const json = await fetchHistoryJson(page, params.namespace, params.code, params.offset, params.size);
  return JSON.stringify(json, null, 2);
}

// Evidence about the one network round-trip a Designer click is supposed to
// cause. `timedOut` means no matching response arrived within the window —
// the caller then has to decide from a content readback, never from the click.
export interface AwaitedResponse {
  status: number | null;
  ok: boolean;
  timedOut: boolean;
  path: string | null;
  /** Compact summary of the response body: `{version, draft}` for a widget PUT, `{errors}` for compile. */
  body?: Record<string, unknown>;
}

interface CompileError { path?: string; desc?: string; level?: string }

type ResponseLike = {
  url(): string;
  status(): number;
  ok(): boolean;
  json(): Promise<unknown>;
  request(): { method(): string };
};

function summarizeBody(path: string, json: unknown): Record<string, unknown> | undefined {
  if (!json || typeof json !== "object") return undefined;
  const j = json as Record<string, any>;
  if (path.endsWith("/compile")) return { errors: Array.isArray(j.errors) ? j.errors : [] };
  const w = j.widget ?? j;
  if (w && typeof w === "object" && "version" in w) return { version: w.version, draft: w.draft };
  return undefined;
}

// Clicks a Designer control and awaits the specific request that click is
// expected to cause. The listener is armed *before* the click (a fast
// response otherwise lands before `waitForResponse` is even installed and
// the wait silently times out), the predicate is pinned to this widget's
// own id (the /lock heartbeat and other widgets' traffic never match), and
// the HTTP status is returned instead of being swallowed. Save and Publish
// are both a `PUT /api/widgets/{widgetId}` — see CLAUDE.md's "Widget REST
// API endpoint map"; Проверить is a `POST /api/widgets/compile`.
async function clickAndAwait(
  page: Page,
  click: () => Promise<void>,
  expected: { method: string; path: string },
  timeoutMs = 15000,
): Promise<AwaitedResponse> {
  const matches = (res: ResponseLike) =>
    res.request().method() === expected.method && new URL(res.url()).pathname === expected.path;
  const response = page.waitForResponse(matches, { timeout: timeoutMs }).then(
    async (res) => {
      const path = new URL(res.url()).pathname;
      const body = summarizeBody(path, await res.json().catch(() => undefined));
      return { status: res.status(), ok: res.ok(), timedOut: false, path, ...(body ? { body } : {}) };
    },
    () => ({ status: null, ok: false, timedOut: true, path: null }),
  );
  await click();
  return response;
}

const widgetPut = (widgetId: string) => ({ method: "PUT", path: `/api/widgets/${widgetId}` });
const widgetCompile = { method: "POST", path: "/api/widgets/compile" };

export async function handleSetWidgetScript(params: z.infer<typeof setWidgetScriptSchema>): Promise<string> {
  const { namespace, code, scriptType, script, comment, publish, expectedVersion } = params;
  const page = await getPage();
  const scriptOf = (w: WidgetDescriptor) => (scriptType === "server" ? w.descriptor?.serverScripts : w.descriptor?.clientScripts);

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

  const alreadyInDesiredState = scriptOf(before) === script && (!publish || !before.draft);
  if (alreadyInDesiredState) {
    return JSON.stringify({
      success: true,
      skipped: true,
      reason: "Script already matches requested content and is not a pending unpublished draft.",
      version: before.version,
      draft: before.draft,
    });
  }

  const widgetId = before.__id;
  const network: { save?: AwaitedResponse; validate?: AwaitedResponse; publish?: AwaitedResponse } = {};

  await openDesigner(page, namespace, code);
  await pasteIntoEditor(page, scriptType, script);

  network.save = await clickAndAwait(page, () => page.getByRole("button", { name: "Сохранить" }).click(), widgetPut(widgetId));
  if (network.save.status !== null && !network.save.ok) {
    return JSON.stringify({
      success: false,
      reason: `Save request failed: PUT ${network.save.path} returned HTTP ${network.save.status}.`,
      version: before.version,
      draft: before.draft,
      network,
    });
  }

  // Confirm the save actually landed rather than trusting the click or even
  // the PUT status: the server-side draft must now carry exactly this text.
  // This is also the fallback when the PUT wait timed out.
  const saved = await fetchWidgetJson(page, namespace, code);
  if (scriptOf(saved) !== script) {
    return JSON.stringify({
      success: false,
      reason: "Save did not take effect: re-fetched draft content does not match what was pasted." +
        (network.save.timedOut ? " No PUT for this widget was observed within the wait window." : ""),
      version: saved.version,
      draft: saved.draft,
      network,
    });
  }

  network.validate = await clickAndAwait(page, () => page.getByRole("button", { name: "check Проверить" }).click(), widgetCompile);

  // Validation verdict comes from the compile response itself. On ELMA365
  // 2025.10 the Опубликовать button stays enabled and the publish dialog
  // opens even when Проверить reported compile errors (observed live on
  // dev2, 2026-10-07) — so the button state alone is not a safeguard. A
  // disabled button (older UI) is still honoured as an additional signal.
  const compileErrors = ((network.validate.body?.errors as CompileError[] | undefined) ?? []).filter(
    (e) => e.level !== "warning",
  );
  const publishButton = page.getByRole("button", { name: "arrow_from_bottom Опубликовать" });
  const isDisabled = await publishButton.isDisabled().catch(() => true);
  if (network.validate.timedOut || !network.validate.ok || compileErrors.length > 0 || isDisabled) {
    return JSON.stringify({
      success: false,
      reason:
        (compileErrors.length > 0
          ? `Validation (Проверить) reported ${compileErrors.length} error(s). `
          : network.validate.timedOut
            ? "No compile response was observed for Проверить within the wait window. "
            : !network.validate.ok
              ? `Compile request returned HTTP ${network.validate.status}. `
              : "Опубликовать is disabled after Проверить. ") +
        "Nothing was published; the pasted text remains an unpublished draft and the published version is unchanged.",
      errors: compileErrors.map((e) => `${e.path ?? ""} ${e.desc ?? ""}`.trim()),
      version: saved.version,
      draft: saved.draft,
      network,
    });
  }

  if (!publish) {
    return JSON.stringify({
      success: true,
      published: false,
      version: saved.version,
      draft: saved.draft,
      note: "Saved + validated only, left as unpublished draft (publish=false).",
      network,
    });
  }

  await publishButton.click();
  // Two nested elements carry role="dialog" here (an outer wrapper plus the
  // real PrimeNG dialog). On 2025.4 the inner one had the accessible name
  // "Версия <n>"; on 2025.10 neither has a name and "Версия <n>" is plain
  // text inside — so match on contained text and take the innermost one
  // instead of a Playwright strict-mode violation.
  const dialog = page.getByRole("dialog").filter({ hasText: /Версия/ }).last();
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  if (comment) {
    await dialog.getByRole("textbox").first().fill(comment);
  }
  network.publish = await clickAndAwait(
    page,
    () => dialog.getByRole("button", { name: "Опубликовать", exact: true }).click(),
    widgetPut(widgetId),
  );

  // Confirm the publish actually took effect — don't trust the click alone.
  // Compare the full published text and require draft:false, not just a
  // version bump (a version bump alone doesn't prove the *content* landed).
  const after = await fetchWidgetJson(page, namespace, code);
  if (after.draft !== false || scriptOf(after) !== script) {
    return JSON.stringify({
      success: false,
      reason: "Publish click completed but re-fetched state doesn't confirm it: " +
        (after.draft !== false ? "widget is still a draft. " : "") +
        (scriptOf(after) !== script ? "published content does not match what was sent." : "") +
        (network.publish.timedOut ? " No PUT for this widget was observed within the wait window." : ""),
      version: after.version,
      draft: after.draft,
      network,
    });
  }

  return JSON.stringify({ success: true, published: true, version: after.version, draft: after.draft, network });
}
