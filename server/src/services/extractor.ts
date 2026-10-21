import * as cheerio from "cheerio";
import { AppError } from "../errors.js";
import type { PageFetcher } from "./fetcher.js";

const REMOVE =
  "script, style, noscript, template, svg, canvas, iframe, object, embed, form, nav, [aria-hidden=true]";
const BLOCK =
  "p, div, section, article, li, tr, h1, h2, h3, h4, h5, h6, br, dt, dd, address, blockquote, header, footer";
const LINE_BREAK = ""; // private-use char; not matched by \s
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|mp[34]|mov|avi|docx?|xlsx?|pptx?|css|js|json|xml|rss)$/i;

// Weight of keywords in a link's path or anchor text (higher = more relevant to call handling).
const KEYWORDS: Record<string, number> = {
  contact: 10, hours: 10, location: 8, locations: 8, about: 8, services: 9, service: 7,
  faq: 9, faqs: 9, pricing: 7, prices: 7, booking: 8, book: 6, appointment: 8, appointments: 8,
  schedule: 6, support: 6, help: 5, team: 4, emergency: 7, insurance: 6, policies: 6, policy: 4,
  "what-we-do": 7, menu: 4, reservations: 7, quote: 6, areas: 5,
};
const NEGATIVE =
  /(blog|news|article|post|tag|category|author|privacy|terms|cookie|login|signin|cart|checkout|careers|jobs|feed|wp-json|wp-admin)/i;

export interface ExtractedPage {
  url: string;
  title: string;
  description: string;
  text: string;
  links: { url: string; text: string }[];
}

/** Turns HTML into readable plain text plus same-site links. */
export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);

  // Collect links before removing navigation; menus are the best index of a site.
  const seen = new Set<string>();
  const links: ExtractedPage["links"] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")?.trim();
    if (!href || /^(mailto|tel|javascript|data):/i.test(href)) return;
    let target: URL;
    try {
      target = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(target.protocol) || !sameSite(target, base)) return;
    if (SKIP_EXT.test(target.pathname)) return;
    target.hash = "";
    const key = pageKey(target.toString());
    if (seen.has(key) || key === pageKey(base.toString())) return;
    seen.add(key);
    links.push({ url: target.toString(), text: clean($(el).text()).slice(0, 100) });
  });

  const title = clean($("title").first().text());
  const description = clean($('meta[name="description"]').attr("content") ?? "");

  $(REMOVE).remove();
  // Mark block boundaries with a sentinel so source-formatting newlines can be collapsed.
  $(BLOCK).each((_, el) => {
    $(el).append(LINE_BREAK);
  });
  const hasMain = $("main").length > 0;
  const root = hasMain ? $("main") : $("body");
  // Footers outside <main> often hold hours, phone numbers and addresses.
  const footer = hasMain ? $("footer").text() : "";
  const seenLines = new Set<string>();
  const text = [root.text(), footer]
    .join(LINE_BREAK)
    .split(LINE_BREAK)
    .map(clean)
    .filter((line) => line && !seenLines.has(line) && seenLines.add(line))
    .join("\n");

  return { url: pageUrl, title, description, text, links };
}

/** Scores a link by how likely it is to contain call-handling relevant information. */
export function scoreLink(link: { url: string; text: string }): number {
  const path = new URL(link.url).pathname.toLowerCase();
  if (NEGATIVE.test(path)) return -1;
  const haystack = `${path} ${link.text.toLowerCase()}`;
  let score = 0;
  for (const [kw, weight] of Object.entries(KEYWORDS)) {
    if (new RegExp(`(^|[^a-z])${kw}([^a-z]|$)`).test(haystack)) score += weight;
  }
  const depth = path.split("/").filter(Boolean).length;
  return score - depth; // prefer shallow pages
}

export interface CrawlOptions {
  maxPages: number;
  maxCharsPerPage?: number;
  maxTotalChars?: number;
  minTotalChars?: number;
}

export interface CrawlResult {
  pages: { url: string; title: string; text: string }[];
  skipped: { url: string; reason: string }[];
}

/** Fetches the start page plus the most relevant same-site pages it links to (depth 1). */
export async function crawlSite(
  startUrl: string,
  fetchPage: PageFetcher,
  { maxPages, maxCharsPerPage = 8_000, maxTotalChars = 40_000, minTotalChars = 200 }: CrawlOptions,
): Promise<CrawlResult> {
  const home = await fetchPage(startUrl);
  const homePage = extractPage(home.html, home.url);
  const homeUrl = new URL(home.url);

  const candidates = homePage.links
    .map((l) => ({ ...l, score: scoreLink(l) }))
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxPages - 1));

  const result: CrawlResult = { pages: [], skipped: [] };
  const added = new Set<string>();
  let total = 0;
  const add = (p: ExtractedPage) => {
    // Different links can redirect to the same final page.
    if (added.has(pageKey(p.url))) return;
    added.add(pageKey(p.url));
    const body = [p.description, p.text].filter(Boolean).join("\n").slice(0, maxCharsPerPage);
    const room = maxTotalChars - total;
    if (room <= 0 || !body) return;
    const text = body.slice(0, room);
    total += text.length;
    result.pages.push({ url: p.url, title: p.title, text });
  };
  add(homePage);

  const fetched = await mapLimit(candidates, 3, async (c) => {
    try {
      const page = await fetchPage(c.url);
      if (!sameSite(new URL(page.url), homeUrl)) {
        return { url: c.url, reason: "redirected off-site" };
      }
      return extractPage(page.html, page.url);
    } catch (err) {
      return { url: c.url, reason: err instanceof AppError ? err.message : "fetch failed" };
    }
  });
  for (const item of fetched) {
    if ("reason" in item) result.skipped.push(item);
    else add(item);
  }

  if (total < minTotalChars) {
    throw new AppError(
      "INSUFFICIENT_CONTENT",
      "Not enough readable text was found on the website (it may rely on JavaScript rendering).",
      422,
    );
  }
  return result;
}

function sameSite(a: URL, b: URL): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return strip(a.hostname) === strip(b.hostname);
}

/** Identity of a page for de-duplication: ignores "www." and a trailing slash. */
function pageKey(u: string): string {
  const url = new URL(u);
  return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
