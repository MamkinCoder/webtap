import { describe, expect, it } from "vitest";
import { personaFor } from "../src/browser/clean.js";

describe("personaFor", () => {
  it("gives Chrome's reduced Windows UA, Win32 and Windows client hints for the build's major version", () => {
    const p = personaFor("windows", "154");
    expect(p.userAgent).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36");
    expect(p.platform).toBe("Win32");
    expect(p.metadata).toMatchObject({ platform: "Windows", architecture: "x86", bitness: "64", mobile: false });
  });

  it("gives the macOS form for mac", () => {
    const p = personaFor("mac", "154");
    expect(p.userAgent).toContain("Macintosh; Intel Mac OS X 10_15_7");
    expect(p.platform).toBe("MacIntel");
    expect(p.metadata.platform).toBe("macOS");
  });
});
