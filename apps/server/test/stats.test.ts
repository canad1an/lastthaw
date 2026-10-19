import { describe, expect, it } from "vitest";
import { deviceKey } from "../src/stats/device.js";

describe("device keys", () => {
  it("names the browser, the system and the form", () => {
    expect(deviceKey("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari · iOS · phone");
    expect(deviceKey("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36")).toBe("Chrome · Android · phone");
    expect(deviceKey("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0")).toBe("Edge · Windows · desktop");
    expect(deviceKey("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")).toBe("Safari · macOS · desktop");
    expect(deviceKey("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.0.0 Mobile/15E148 Safari/604.1")).toBe("Chrome · iOS · tablet");
    expect(deviceKey("Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0")).toBe("Firefox · Linux · desktop");
    expect(deviceKey(undefined)).toBe("unknown");
  });
});
