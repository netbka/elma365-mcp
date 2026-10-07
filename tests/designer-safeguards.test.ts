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
const state = (text = "original", draft = false, version = 7) => ({
  version, draft, descriptor: { clientScripts: text, serverScripts: text },
});

// Only the browser boundary is mocked. This executes the successor handler
// without opening a browser or contacting ELMA; it is not live acceptance.
function browser(before = state(), after = state(script, false, 8)) {
  const clicks: string[] = [];
  const control = (name: string): any => ({
    click: vi.fn(async () => { clicks.push(name); }),
    check: vi.fn(), waitFor: vi.fn(), fill: vi.fn(),
    isDisabled: vi.fn(async () => false),
    first() { return this; },
    getByRole: (_role: string, options: { name?: string } = {}) => control(`dialog:${options.name ?? "textbox"}`),
  });
  const publish = control("arrow_from_bottom Опубликовать");
  const line = {
    first() { return this; }, waitFor: vi.fn(),
    boundingBox: vi.fn(async () => ({ x: 0, y: 0 })),
    allTextContents: vi.fn(async () => [script]),
  };
  let reads = 0;
  const page = {
    evaluate: vi.fn(async (_fn: unknown, arg: unknown) => {
      if (typeof arg === "string") return;
      return reads++ === 0 ? before : after;
    }),
    goto: vi.fn(), locator: vi.fn(() => line),
    getByRole: vi.fn((_role: string, options: { name: string }) =>
      options.name === "arrow_from_bottom Опубликовать" ? publish : control(String(options.name))),
    mouse: { click: vi.fn() }, keyboard: { press: vi.fn() },
    waitForTimeout: vi.fn(), waitForResponse: vi.fn(async () => ({})),
  };
  session.getPage.mockResolvedValue(page);
  return { page, clicks, publish, line };
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
    expect(JSON.parse(await handleSetWidgetScript(params()))).toMatchObject({
      success: true, published: true, version: 8, draft: false,
    });
    expect(clicks).toContain("Сохранить");
    expect(clicks).toContain("check Проверить");
    expect(clicks).toContain("dialog:Опубликовать");
    expect(page.evaluate).toHaveBeenCalledTimes(3);
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
    const { clicks } = browser(state(), state(script, true));
    expect(JSON.parse(await handleSetWidgetScript(params({ publish: false, scriptType })))).toMatchObject({
      success: true, published: false, draft: true,
    });
    expect(clicks).not.toContain("arrow_from_bottom Опубликовать");
    expect(clicks).not.toContain("dialog:Опубликовать");
  });

  it("unapplied save returns failure", async () => {
    browser(state(), state("original", true));
    expect(JSON.parse(await handleSetWidgetScript(params({ publish: false })))).toMatchObject({ success: false });
  });

  it.each([state(script, true, 8), state("wrong text", false, 8)])("rejects unconfirmed publication %#", async (after) => {
    browser(state(), after);
    expect(JSON.parse(await handleSetWidgetScript(params()))).toMatchObject({ success: false });
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
