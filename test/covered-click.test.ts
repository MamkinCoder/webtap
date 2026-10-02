// coveredClickJs against a minimal fake DOM: a clear target, a target under an overlay, a label over its own input,
// a target outside this document.
import { describe, expect, it, vi } from "vitest";
import { coveredClickJs } from "../src/browser/session.js";

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type El = { tagName: string; id: string; className: string; click: () => void; getBoundingClientRect: () => Rect; contains: (o: unknown) => boolean; closest: (s: string) => unknown; control?: El; scrollIntoView: () => void };
const box: Rect = { left: 100, top: 100, right: 300, bottom: 150, width: 200, height: 50 };
const el = (tagName: string, over: Partial<El> = {}): El => ({
  tagName,
  id: "",
  className: "",
  click: vi.fn(),
  getBoundingClientRect: () => box,
  contains: (o) => o === undefined,
  closest: () => null,
  scrollIntoView: () => undefined,
  ...over,
});
const run = (target: El | null, top: El) =>
  new Function("document", "innerHeight", "innerWidth", `return ${coveredClickJs("#submit")}`)(
    { querySelector: () => target, elementFromPoint: () => top },
    800,
    1300,
  ) as string;

describe("coveredClickJs", () => {
  it("leaves a clear target to the mouse click", () => {
    const b = el("BUTTON");
    expect(run(b, b)).toBe("clear");
    expect(b.click).not.toHaveBeenCalled();
  });

  it("clicks through the DOM when an overlay covers the target", () => {
    const b = el("BUTTON");
    expect(run(b, el("DIV", { id: "cf7Popup", className: "popup popup-active" }))).toBe("covered by div#cf7Popup.popup.popup-active");
    expect(b.click).toHaveBeenCalledOnce();
  });

  it("a label on top of its own checkbox is not a cover", () => {
    const cb = el("INPUT");
    const label = el("LABEL", { control: cb });
    expect(run(cb, el("SPAN", { closest: () => label }))).toBe("clear");
    expect(cb.click).not.toHaveBeenCalled();
  });

  it("a target not in this document (iframe) or without a box is left to Stagehand", () => {
    expect(run(null, el("DIV"))).toBe("clear");
    const hidden = el("BUTTON", { getBoundingClientRect: () => ({ ...box, width: 0, height: 0 }) });
    expect(run(hidden, el("DIV"))).toBe("clear");
  });
});
