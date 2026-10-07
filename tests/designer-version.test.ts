import { afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock("../src/designer/session.js", () => ({ getPage: session.getPage, designerBaseUrl: () => "https://designer.invalid" }));
import { getWidgetVersionSchema, handleGetWidgetVersion } from "../src/tools/designer.js";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const revisionId = "01a00000-0000-7000-8000-000000000002";
const widgetId = "01a00000-0000-7000-8000-000000000001";
const params = getWidgetVersionSchema.parse({ namespace: "synthetic.records", code: "view_form", revisionId });
const native = { __id: revisionId, widgetId, version: 3, descriptor: { clientScripts: "inert synthetic source" }, runtime: { unknown: true }, __createdBy: "native-author", comment: "synthetic" };

function browser(body: unknown = native, widget: unknown = { __id: widgetId }) {
  session.getPage.mockResolvedValue({ evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) });
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => widget })
    .mockResolvedValueOnce({ ok: true, json: async () => body });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("native historical widget body", () => {
  it("preserves source/runtime/native author and only issues credentialed reads", async () => {
    const fetch = browser();
    expect(JSON.parse(await handleGetWidgetVersion(params))).toEqual(native);
    expect(fetch.mock.calls).toEqual([
      ["/api/widgets/get/synthetic.records/view_form", { credentials: "include" }],
      [`/api/widgets/version/${revisionId}`, { credentials: "include" }],
    ]);
  });

  it.each([null, {}, { ...native, __id: widgetId }, { ...native, widgetId: revisionId },
    { ...native, version: "3" }, { ...native, version: 0 }, { ...native, version: 1.5 }])
    ("refuses foreign or malformed revision evidence: %j", async body => {
      browser(body);
      await expect(handleGetWidgetVersion(params)).rejects.toThrow("Historical revision identity does not match");
    });

  it("does not request historical data when current widget identity is unavailable", async () => {
    const fetch = browser(native, {});
    await expect(handleGetWidgetVersion(params)).rejects.toThrow("Current widget identity is unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("encodes namespace/code and propagates inaccessible history without claiming authorship", async () => {
    const fetch = browser();
    fetch.mockReset().mockResolvedValueOnce({ ok: true, json: async () => ({ __id: widgetId }) })
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" });
    await expect(handleGetWidgetVersion({ ...params, namespace: "ns/other", code: "form?x=1" }))
      .rejects.toThrow("GET widget version failed: 403 Forbidden");
    expect(fetch.mock.calls[0][0]).toBe("/api/widgets/get/ns%2Fother/form%3Fx%3D1");
  });

  it("requires a native UUID rather than a numeric version or path", () => {
    for (const revisionId of ["3", "../version", "", "not-a-uuid"]) {
      expect(getWidgetVersionSchema.safeParse({ ...params, revisionId }).success).toBe(false);
    }
  });

  it("preserves unavailable native authorship instead of inferring it from the session", async () => {
    const { __createdBy, ...withoutAuthor } = native;
    browser(withoutAuthor);
    expect(JSON.parse(await handleGetWidgetVersion(params))).toEqual(withoutAuthor);
  });

  it("stops after an inaccessible current widget rather than returning an unbound revision", async () => {
    const fetch = browser();
    fetch.mockReset().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });
    await expect(handleGetWidgetVersion(params)).rejects.toThrow("GET widget failed: 404 Not Found");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
