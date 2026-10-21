import { describe, expect, it } from "vitest";
import { isBlockedIp, validatePublicUrl } from "../src/security/url.js";

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1", "127.255.0.1", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "fc00::1",
    "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::",
    "2001:db8::1", "not-an-ip", "",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe("validatePublicUrl", () => {
  it("accepts and normalises public URLs", () => {
    expect(validatePublicUrl("example.com").toString()).toBe("https://example.com/");
    expect(validatePublicUrl("  http://Example.com/about#team ").toString()).toBe("http://example.com/about");
    expect(validatePublicUrl("https://example.com:443/x").toString()).toBe("https://example.com/x");
  });

  it.each([
    ["", "INVALID_URL"],
    ["ftp://example.com", "INVALID_URL"],
    ["file:///etc/passwd", "INVALID_URL"],
    ["javascript:alert(1)", "INVALID_URL"],
    ["http://user:pass@example.com", "INVALID_URL"],
    ["http://", "INVALID_URL"],
    [`https://example.com/${"a".repeat(3000)}`, "INVALID_URL"],
    ["http://example.com:8080", "BLOCKED_URL"],
    ["http://example.com:22", "BLOCKED_URL"],
    ["http://localhost", "BLOCKED_URL"],
    ["http://foo.localhost", "BLOCKED_URL"],
    ["http://printer.local", "BLOCKED_URL"],
    ["http://metadata.google.internal", "BLOCKED_URL"],
    ["http://intranet", "BLOCKED_URL"],
    ["http://127.0.0.1", "BLOCKED_URL"],
    ["http://169.254.169.254/latest/meta-data", "BLOCKED_URL"],
    ["http://2130706433", "BLOCKED_URL"], // decimal 127.0.0.1
    ["http://0x7f.0.0.1", "BLOCKED_URL"], // hex
    ["http://0177.0.0.1", "BLOCKED_URL"], // octal
    ["http://127.1", "BLOCKED_URL"], // shorthand
    ["http://[::1]", "BLOCKED_URL"],
    ["http://[::ffff:127.0.0.1]", "BLOCKED_URL"],
    ["http://[fd00::1]", "BLOCKED_URL"],
    ["http://10.1.2.3", "BLOCKED_URL"],
    ["http://0.0.0.0", "BLOCKED_URL"],
  ])("rejects %s", (input, code) => {
    expect(() => validatePublicUrl(input)).toThrow(expect.objectContaining({ code }));
  });
});
