import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock("../src/designer/session.js", () => ({
  getPage: session.getPage,
  designerBaseUrl: () => "https://designer.invalid",
}));
import { handleSetWidgetScript, setWidgetScriptSchema } from "../src/tools/designer.js";

const script = "async function onInit() { return 1; }";
const params = (overrides = {}) => setWidgetScriptSchema.parse({
  namespace: "test.app", code: "test_widget", scriptType: "client",
  script, expectedVersion: 7, ...overrides,
});
const widgetId = "01a00000-0000-7000-8000-000000000001";
const state = (text = "original", draft = false, version = 7) => ({
  __id: widgetId, version, draft, descriptor: { clientScripts: text, serverScripts: text },
});
const response = (status: number, path: string, method = "PUT", body: unknown = { widget: { version: 7, draft: true } }) => ({
  status: () => status, ok: () => status < 400, json: async () => body,
  url: () => `https://designer.invalid${path}`, request: () => ({ method: () => method }),
});
const compile = (errors: unknown[] = []) => response(200, "/api/widgets/compile", "POST", { errors });

// Only the browser boundary is mocked. This executes the successor handler
// without opening a browser or contacting ELMA; it is not live acceptance.
// `states` are returned by successive widget reads: [before, after save, after publish].
function browser(
  before = state(), after = state(script, false, 8), afterSave = state(script, true, 7),
  ui: { radios?: boolean; pressed?: boolean } = {},
) {
  const { radios = true, pressed = true } = ui;
  const clicks: string[] = [];
  // Responses the mocked server "sends" for each click; the handler must
  // await exactly these (listener armed before the click, matched by path).
  const responses: Record<string, ReturnType<typeof response>> = {
    "Сохранить": response(200, `/api/widgets/${widgetId}`),
    "check Проверить": compile(),
    "dialog:Опубликовать": response(200, `/api/widgets/${widgetId}`, "PUT", { widget: { version: 8, draft: false } }),
  };
  let pending: ((res: ReturnType<typeof response>) => void) | null = null;
  const control = (name: string): any => ({
    click: vi.fn(async () => {
      clicks.push(name);
      const res = responses[name];
      if (res && pending) { pending(res); pending = null; }
    }),
    check: vi.fn(), waitFor: vi.fn(), fill: vi.fn(),
    count: vi.fn(async () => (radios ? 1 : 0)),
    getAttribute: vi.fn(async () => (pressed ? "true" : "false")),
    isDisabled: vi.fn(async () => false),
    first() { return this; }, last() { return this; }, filter() { return this; },
    getByRole: (_role: string, options: { name?: string } = {}) => control(`dialog:${options.name ?? "textbox"}`),
  });
  const publish = control("arrow_from_bottom Опубликовать");
  const line = {
    first() { return this; }, waitFor: vi.fn(),
    boundingBox: vi.fn(async () => ({ x: 0, y: 0 })),
    allTextContents: vi.fn(async () => [script]),
  };
  const states = [before, afterSave, after];
  let reads = 0;
  const page = {
    evaluate: vi.fn(async (_fn: unknown, arg: unknown) => {
      if (typeof arg === "string") return;
      return states[Math.min(reads++, states.length - 1)];
    }),
    goto: vi.fn(), locator: vi.fn(() => line),
    getByRole: vi.fn((role: string, options: { name?: string } = {}) =>
      options.name === "arrow_from_bottom Опубликовать" ? publish : control(String(options.name ?? role))),
    mouse: { click: vi.fn() }, keyboard: { press: vi.fn() },
    waitForTimeout: vi.fn(),
    waitForResponse: vi.fn((predicate: (res: ReturnType<typeof response>) => boolean, options: { timeout: number }) =>
      new Promise((resolve, reject) => {
        clicks.push("arm");
        const timer = setTimeout(() => reject(new Error("Timeout")), options.timeout);
        // A click whose response doesn't satisfy the predicate behaves like a timeout immediately.
        pending = (res) => { clearTimeout(timer); if (predicate(res)) resolve(res); else reject(new Error("Timeout")); };
      })),
  };
  session.getPage.mockResolvedValue(page);
  return { page, clicks, publish, line, responses };
}

beforeEach(() => vi.clearAllMocks());

describe("successor Designer safeguards (local browser boundary)", () => {
  it("version conflict performs no navigation, paste, save or publish", async () => {
    const { page, clicks } = browser();
    const result = JSON.parse(await handleSetWidgetScript(params({ expectedVersion: 6 })));
    expect(result).toMatchObject({ success: false, version: 7, draft: false });
    expect(result.reason).toContain("Version conflict");
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
  });

  it("matching version saves, validates, publishes and reads back", async () => {
    const { page, clicks } = browser();
    const result = JSON.parse(await handleSetWidgetScript(params()));
    expect(result).toMatchObject({
      success: true, published: true, version: 8, draft: false,
      network: {
        save: { status: 200, ok: true, timedOut: false, path: `/api/widgets/${widgetId}`, body: { version: 7, draft: true } },
        validate: { status: 200, ok: true, timedOut: false, path: "/api/widgets/compile", body: { errors: [] } },
        publish: { status: 200, ok: true, timedOut: false, path: `/api/widgets/${widgetId}`, body: { version: 8, draft: false } },
      },
    });
    expect(clicks).toContain("Сохранить");
    expect(clicks).toContain("check Проверить");
    expect(clicks).toContain("dialog:Опубликовать");
    // before, clipboard, after-save readback, after-publish readback
    expect(page.evaluate).toHaveBeenCalledTimes(4);
  });

  it("arms the response listener before every awaited click", async () => {
    const { clicks } = browser();
    await handleSetWidgetScript(params());
    for (const name of ["Сохранить", "check Проверить", "dialog:Опубликовать"]) {
      const at = clicks.indexOf(name);
      expect(at).toBeGreaterThan(0);
      expect(clicks[at - 1]).toBe("arm");
    }
  });

  it("a failed save PUT stops before validation and publication", async () => {
    const { clicks, responses } = browser();
    responses["Сохранить"] = response(500, `/api/widgets/${widgetId}`);
    const result = JSON.parse(await handleSetWidgetScript(params()));
    expect(result).toMatchObject({ success: false, version: 7, draft: false, network: { save: { status: 500, ok: false } } });
    expect(result.reason).toContain("HTTP 500");
    expect(clicks).not.toContain("check Проверить");
    expect(clicks).not.toContain("dialog:Опубликовать");
  });

  it("the lock heartbeat or another widget's PUT never satisfies the save wait; readback decides", async () => {
    const { responses } = browser();
    responses["Сохранить"] = response(200, `/api/widgets/${widgetId}/lock`);
    const result = JSON.parse(await handleSetWidgetScript(params({ publish: false })));
    expect(result).toMatchObject({ success: true, published: false, network: { save: { timedOut: true, status: null } } });
  });

  it("a timed-out save with unapplied content fails and says no PUT was seen", async () => {
    const { responses } = browser(state(), undefined, state("original", true));
    responses["Сохранить"] = response(200, `/api/widgets/other-widget`);
    const result = JSON.parse(await handleSetWidgetScript(params({ publish: false })));
    expect(result).toMatchObject({ success: false, network: { save: { timedOut: true } } });
    expect(result.reason).toContain("No PUT for this widget was observed");
  });

  it("selects the script kind through 2025.10 toggle buttons when no radios exist", async () => {
    const { clicks } = browser(state(), undefined, undefined, { radios: false, pressed: false });
    await handleSetWidgetScript(params({ publish: false, scriptType: "server" }));
    expect(clicks).toContain("Сервер");
  });

  it("does not re-click an already pressed toggle", async () => {
    const { clicks } = browser(state(), undefined, undefined, { radios: false, pressed: true });
    await handleSetWidgetScript(params({ publish: false }));
    expect(clicks).not.toContain("Клиент");
  });

  it("already published identical content is a no-op", async () => {
    const { clicks, page } = browser(state(script));
    expect(JSON.parse(await handleSetWidgetScript(params()))).toMatchObject({ success: true, skipped: true });
    expect(clicks).toEqual([]);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("identical content in a draft still needs publication", async () => {
    const { clicks } = browser(state(script, true));
    expect(JSON.parse(await handleSetWidgetScript(params()))).toMatchObject({ success: true, published: true });
    expect(clicks).toContain("dialog:Опубликовать");
  });

  it.each(["client", "server"])("save-only reads back full %s text and never publishes", async (scriptType) => {
    const { clicks, page } = browser(state(), undefined, state(script, true));
    expect(JSON.parse(await handleSetWidgetScript(params({ publish: false, scriptType })))).toMatchObject({
      success: true, published: false, draft: true,
    });
    expect(clicks).toContain("check Проверить");
    expect(clicks).not.toContain("arrow_from_bottom Опубликовать");
    expect(clicks).not.toContain("dialog:Опубликовать");
    expect(page.evaluate).toHaveBeenCalledTimes(3);
  });

  it("unapplied save returns failure before validation", async () => {
    const { clicks } = browser(state(), undefined, state("original", true));
    expect(JSON.parse(await handleSetWidgetScript(params({ publish: false })))).toMatchObject({ success: false });
    expect(clicks).not.toContain("check Проверить");
  });

  it.each([state(script, true, 8), state("wrong text", false, 8)])("rejects unconfirmed publication %#", async (after) => {
    browser(state(), after);
    expect(JSON.parse(await handleSetWidgetScript(params()))).toMatchObject({ success: false });
  });

  it("compile errors block publication even though the Designer leaves Опубликовать enabled (2025.10)", async () => {
    const { clicks, responses, publish } = browser();
    publish.isDisabled.mockResolvedValue(false);
    responses["check Проверить"] = compile([
      { path: "/SCRIPTS:69:6", desc: "Type 'string' is not assignable to type 'number'.", level: "error" },
      { path: "/", desc: "error on script compilation" },
    ]);
    const result = JSON.parse(await handleSetWidgetScript(params()));
    expect(result).toMatchObject({ success: false, draft: true, version: 7 });
    expect(result.reason).toContain("2 error(s)");
    expect(result.errors).toHaveLength(2);
    expect(clicks).not.toContain("arrow_from_bottom Опубликовать");
    expect(clicks).not.toContain("dialog:Опубликовать");
  });

  it("compile warnings alone do not block publication", async () => {
    const { clicks, responses } = browser();
    responses["check Проверить"] = compile([{ path: "/SCRIPTS:1:1", desc: "unused", level: "warning" }]);
    expect(JSON.parse(await handleSetWidgetScript(params()))).toMatchObject({ success: true, published: true });
    expect(clicks).toContain("dialog:Опубликовать");
  });

  it("an unobserved compile response blocks publication", async () => {
    const { clicks, responses } = browser();
    responses["check Проверить"] = response(200, "/api/widgets/execute", "POST", {});
    const result = JSON.parse(await handleSetWidgetScript(params()));
    expect(result).toMatchObject({ success: false, network: { validate: { timedOut: true } } });
    expect(clicks).not.toContain("dialog:Опубликовать");
  });

  it("disabled publication after validation reports failure without publishing", async () => {
    const { clicks, publish } = browser();
    publish.isDisabled.mockResolvedValue(true);
    expect(JSON.parse(await handleSetWidgetScript(params()))).toMatchObject({ success: false });
    expect(clicks).not.toContain("arrow_from_bottom Опубликовать");
  });

  it("failed paste integrity check aborts before saving", async () => {
    const { clicks, line } = browser();
    line.allTextContents.mockResolvedValue(["unrelated text"]);
    await expect(handleSetWidgetScript(params())).rejects.toThrow("Paste verification failed");
    expect(clicks).not.toContain("Сохранить");
  });
});
