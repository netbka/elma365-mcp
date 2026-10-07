import { afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock("../src/designer/session.js", () => ({
  getPage: session.getPage,
  designerBaseUrl: () => "https://designer.invalid",
}));
import { getWidgetHistorySchema, handleGetWidgetHistory } from "../src/tools/designer.js";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

// Execute the browser callback with a synthetic HTTP boundary, rather than
// supplying the handler's result. No login or live ELMA operation is performed.
function browser() {
  session.getPage.mockResolvedValue({ evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) });
}

describe("Designer history pages", () => {
  it("requests successive offsets with session credentials and preserves native rows", async () => {
    browser();
    const rows = [{ version: 3, __createdBy: "synthetic-a" }, { version: 2, __createdBy: "synthetic-b" }];
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [rows[0]] })
      .mockResolvedValueOnce({ ok: true, json: async () => [rows[1]] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetch);
    const input = { namespace: "synthetic.records", code: "view_form", size: 1 };
    expect(JSON.parse(await handleGetWidgetHistory(getWidgetHistorySchema.parse(input)))).toEqual([rows[0]]);
    expect(JSON.parse(await handleGetWidgetHistory(getWidgetHistorySchema.parse({ ...input, offset: 1 })))).toEqual([rows[1]]);
    expect(JSON.parse(await handleGetWidgetHistory(getWidgetHistorySchema.parse({ ...input, offset: 2 })))).toEqual([]);
    expect(fetch.mock.calls).toEqual([0, 1, 2].map(offset => [
      `/api/widgets/history/synthetic.records/view_form/${offset}/1`, { credentials: "include" },
    ]));
  });

  it("encodes object identifiers as single path segments and propagates server failures", async () => {
    browser();
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });
    vi.stubGlobal("fetch", fetch);
    await expect(handleGetWidgetHistory(getWidgetHistorySchema.parse({ namespace: "ns/other", code: "form?x=1", offset: 50 })))
      .rejects.toThrow("GET history failed: 403 Forbidden");
    expect(fetch).toHaveBeenCalledWith("/api/widgets/history/ns%2Fother/form%3Fx%3D1/50/10", { credentials: "include" });
  });
});
