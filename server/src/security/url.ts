import { BlockList, isIP } from "node:net";
import { AppError } from "../errors.js";

const MAX_URL_LENGTH = 2048;
const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

// Non-public address ranges (private, loopback, link-local, CGNAT, documentation,
// multicast, reserved, cloud metadata, and IPv4-in-IPv6 transition ranges).
// Separate lists: a single BlockList also matches IPv4 against IPv4-mapped IPv6 rules.
const blockListV4 = new BlockList();
const blockListV6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockListV4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback (::1) and IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blockListV6.addSubnet(net, prefix, "ipv6");
}

/** True when the address must never be contacted (non-public or unparseable). */
export function isBlockedIp(address: string): boolean {
  if (address.includes("%")) return true; // zone-scoped IPv6
  const family = isIP(address);
  if (family === 4) return blockListV4.check(address, "ipv4");
  if (family === 6) return blockListV6.check(address, "ipv6");
  return true;
}

export interface UrlPolicy {
  isBlockedIp?: (address: string) => boolean;
  allowedPorts?: readonly number[];
}

/**
 * Normalises user input into a URL and rejects anything that is not a plain
 * public http(s) URL. Hostnames are checked again at connect time (see fetcher).
 */
export function validatePublicUrl(input: string, policy: UrlPolicy = {}): URL {
  const blocked = policy.isBlockedIp ?? isBlockedIp;
  const allowedPorts = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS;

  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new AppError("INVALID_URL", "Please enter a website URL.");
  if (raw.length > MAX_URL_LENGTH) throw new AppError("INVALID_URL", "URL is too long.");

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new AppError("INVALID_URL", "That doesn't look like a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("INVALID_URL", "Only http and https URLs are supported.");
  }
  if (url.username || url.password) {
    throw new AppError("INVALID_URL", "URLs with embedded credentials are not allowed.");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowedPorts.includes(port)) {
    throw new AppError("BLOCKED_URL", "Only standard web ports (80/443) are allowed.");
  }

  // WHATWG URL already canonicalises numeric/hex IPv4 forms (e.g. 2130706433 -> 127.0.0.1).
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new AppError("INVALID_URL", "URL must include a hostname.");
  if (isIP(host)) {
    if (blocked(host)) throw blockedError();
  } else if (
    host === "localhost" ||
    !host.includes(".") ||
    BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))
  ) {
    throw blockedError();
  }

  url.hash = "";
  return url;
}

export function blockedError(): AppError {
  return new AppError(
    "BLOCKED_URL",
    "That address points to a private or internal network and can't be analysed.",
  );
}
