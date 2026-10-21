import { describe, expect, it } from "vitest";
import { crawlSite, extractPage, scoreLink } from "../src/services/extractor.js";
import type { PageFetcher } from "../src/services/fetcher.js";
import { AppError } from "../src/errors.js";

const HOME = `<!doctype html><html><head>
  <title>Acme Plumbing</title>
  <meta name="description" content="24/7 emergency plumbing in Springfield.">
  <style>.x{color:red}</style><script>var secret = "do-not-include";</script>
</head><body>
  <nav><a href="/contact">Contact</a><a href="/services">Services</a><a href="/blog/post-1">Blog</a></nav>
  <main>
    <h1>Welcome to Acme</h1>
    <p>We fix   leaks and
      install boilers.</p>
    <ul><li>Leak repair</li><li>Boiler install</li></ul>
    <a href="/about-us">About us</a>
    <a href="https://www.acme.test/faq#top">FAQ</a>
    <a href="https://evil.test/contact">External</a>
    <a href="mailto:hi@acme.test">Email</a><a href="tel:+15551234">Call</a>
    <a href="/brochure.pdf">Brochure</a>
    <form><input value="hidden form"></form>
  </main>
  <footer>Call 555-1234. Mon–Fri 8am–6pm.</footer>
</body></html>`;

describe("extractPage", () => {
  const page = extractPage(HOME, "https://acme.test/");

  it("extracts title, description and readable text", () => {
    expect(page.title).toBe("Acme Plumbing");
    expect(page.description).toBe("24/7 emergency plumbing in Springfield.");
    expect(page.text).toContain("We fix leaks and install boilers.");
    expect(page.text).toContain("Leak repair\nBoiler install");
    expect(page.text).toContain("Mon–Fri 8am–6pm");
  });

  it("drops scripts, styles, nav and forms", () => {
    expect(page.text).not.toContain("do-not-include");
    expect(page.text).not.toContain("color:red");
    expect(page.text).not.toContain("hidden form");
    expect(page.text).not.toMatch(/^Blog$/m);
  });

  it("keeps only same-site, non-asset http links (www-insensitive, no fragments)", () => {
    const urls = page.links.map((l) => l.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://acme.test/contact",
        "https://acme.test/services",
        "https://acme.test/about-us",
        "https://www.acme.test/faq",
      ]),
    );
    expect(urls.some((x) => x.includes("evil.test"))).toBe(false);
    expect(urls.some((x) => /mailto|tel:|\.pdf/.test(x))).toBe(false);
  });
});

describe("scoreLink", () => {
  it("ranks contact/services above blog/legal pages", () => {
    const s = (path: string, text = "") => scoreLink({ url: `https://a.test${path}`, text });
    expect(s("/contact")).toBeGreaterThan(0);
    expect(s("/services")).toBeGreaterThan(s("/random-page"));
    expect(s("/blog/hours-update")).toBeLessThan(0);
    expect(s("/privacy-policy")).toBeLessThan(0);
    expect(s("/p/1", "Opening hours")).toBeGreaterThan(0);
  });
});

describe("crawlSite", () => {
  const pages: Record<string, string> = {
    "https://acme.test/": HOME,
    "https://acme.test/contact": "<main><p>Contact us at 555-1234, 1 Main St.</p></main>",
    "https://acme.test/services": "<main><p>Services: drains, boilers, leaks.</p></main>",
    "https://acme.test/about-us": "<main><p>Family owned since 1990.</p></main>",
    "https://www.acme.test/faq": "<main><p>Do you do emergencies? Yes.</p></main>",
  };
  const fetchPage: PageFetcher = async (url) => {
    if (url === "https://acme.test/about-us") throw new AppError("FETCH_FAILED", "boom", 502);
    const html = pages[url];
    if (!html) throw new Error(`unexpected fetch ${url}`);
    return { url, html };
  };

  it("fetches the homepage plus the top-ranked pages, up to maxPages", async () => {
    const fetched: string[] = [];
    const spy: PageFetcher = (url) => {
      fetched.push(url);
      return fetchPage(url);
    };
    const result = await crawlSite("https://acme.test/", spy, { maxPages: 3, minTotalChars: 10 });
    expect(fetched).toHaveLength(3);
    expect(fetched).not.toContain("https://acme.test/blog/post-1");
    expect(result.pages[0].url).toBe("https://acme.test/");
    expect(result.pages.map((p) => p.url)).toContain("https://acme.test/contact");
  });

  it("records failed pages as skipped instead of failing", async () => {
    const result = await crawlSite("https://acme.test/", fetchPage, { maxPages: 8, minTotalChars: 10 });
    expect(result.skipped).toEqual([{ url: "https://acme.test/about-us", reason: "boom" }]);
    expect(result.pages.length).toBe(4);
  });

  it("caps text per page and in total", async () => {
    const result = await crawlSite("https://acme.test/", fetchPage, {
      maxPages: 8,
      maxCharsPerPage: 30,
      maxTotalChars: 70,
      minTotalChars: 10,
    });
    expect(result.pages.every((p) => p.text.length <= 30)).toBe(true);
    expect(result.pages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(70);
  });

  it("skips pages that redirect off-site", async () => {
    const offsite: PageFetcher = async (url) =>
      url === "https://acme.test/contact" ? { url: "https://evil.test/", html: "<p>x</p>" } : fetchPage(url);
    const result = await crawlSite("https://acme.test/", offsite, { maxPages: 8, minTotalChars: 10 });
    expect(result.skipped).toContainEqual({ url: "https://acme.test/contact", reason: "redirected off-site" });
  });

  it("de-duplicates trailing-slash links and pages that redirect to the same URL", async () => {
    const html = `<main><p>${"Home text. ".repeat(30)}</p>
      <a href="/contact">Contact</a><a href="/contact/">Contact us</a><a href="/services">Services</a></main>`;
    const fetched: string[] = [];
    const f: PageFetcher = async (url) => {
      fetched.push(url);
      // /services redirects to the same final page as /contact
      const final = url.includes("services") ? "https://d.test/contact/" : url;
      return { url: final, html: url === "https://d.test/" ? html : "<p>Contact page</p>" };
    };
    const result = await crawlSite("https://d.test/", f, { maxPages: 8 });
    expect(fetched.filter((u) => u.includes("contact"))).toHaveLength(1);
    expect(result.pages.map((p) => p.url)).toEqual(["https://d.test/", "https://d.test/contact"]);
  });

  it("fails clearly when there is too little text", async () => {
    const empty: PageFetcher = async (url) => ({ url, html: "<div id=root></div><script>app()</script>" });
    await expect(crawlSite("https://spa.test/", empty, { maxPages: 3 })).rejects.toMatchObject({
      code: "INSUFFICIENT_CONTENT",
    });
  });
});
