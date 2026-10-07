import { describe, it, expect } from "vitest";
import { getWidgetSchema, getWidgetHistorySchema, setWidgetScriptSchema } from "../src/tools/designer.js";

// This file locks in schema shape/defaults. designer-safeguards.test.ts
// exercises the handler through a mocked browser boundary. The README's
// older live round-trip covers the predecessor; successor safeguards still
// need fresh real Designer save/validate/publish/revert acceptance evidence.

describe("designer tool schemas", () => {
  it("getWidgetSchema requires namespace + code", () => {
    expect(() => getWidgetSchema.parse({})).toThrow();
    const parsed = getWidgetSchema.parse({ namespace: "ns", code: "widget" });
    expect(parsed).toEqual({ namespace: "ns", code: "widget" });
  });

  it("getWidgetHistorySchema defaults size to 10", () => {
    const parsed = getWidgetHistorySchema.parse({ namespace: "ns", code: "widget" });
    expect(parsed.size).toBe(10);
  });

  it("getWidgetHistorySchema rejects size outside 1..50", () => {
    expect(() => getWidgetHistorySchema.parse({ namespace: "ns", code: "widget", size: 0 })).toThrow();
    expect(() => getWidgetHistorySchema.parse({ namespace: "ns", code: "widget", size: 51 })).toThrow();
  });

  it("setWidgetScriptSchema defaults publish to true and comment is optional", () => {
    const parsed = setWidgetScriptSchema.parse({
      namespace: "ns",
      code: "widget",
      scriptType: "client",
      script: "async function onInit() {}",
    });
    expect(parsed.publish).toBe(true);
    expect(parsed.comment).toBeUndefined();
  });

  it("setWidgetScriptSchema only accepts client|server for scriptType", () => {
    expect(() =>
      setWidgetScriptSchema.parse({ namespace: "ns", code: "widget", scriptType: "both", script: "" }),
    ).toThrow();
  });
});
