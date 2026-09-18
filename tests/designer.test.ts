import { describe, it, expect } from "vitest";
import { getWidgetSchema, getWidgetHistorySchema, setWidgetScriptSchema } from "../src/tools/designer.js";

// Full designer tool behavior needs a real Chromium session driving the App
// Designer UI — not something worth mocking through Playwright's launch
// chain for a unit test. These tools are instead verified with a live
// round-trip against a real server (see README.md "Designer tools" for the
// documented test-and-revert trail). This file just locks in the schemas'
// shape/defaults so a refactor can't silently drop a required field.

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
