import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type FeedItem = {
  id: string;
  title: string;
  link: string;
  published?: string;
  summary?: string;
  company?: string;
  location?: string;
  source?: string;
};

const ITEM_RE = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_JOB_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function ipv4Number(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function ipv4InRange(value: number, mask: number, prefix: number) {
  return ((value & mask) >>> 0) === (prefix >>> 0);
}

export function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().split("%", 1)[0];
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (isIP(normalized) === 4) {
    const value = ipv4Number(normalized);
    if (value === null) return true;
    return (
      ipv4InRange(value, 0xff000000, 0x00000000) || // unspecified/current host
      ipv4InRange(value, 0xff000000, 0x0a000000) || // 10/8
      ipv4InRange(value, 0xff000000, 0x7f000000) || // loopback
      ipv4InRange(value, 0xfff00000, 0xac100000) || // 172.16/12
      ipv4InRange(value, 0xffff0000, 0xa9fe0000) || // link-local and metadata
      ipv4InRange(value, 0xffff0000, 0xc0a80000) || // 192.168/16
      ipv4InRange(value, 0xffc00000, 0x64400000) || // carrier-grade NAT
      ipv4InRange(value, 0xffffff00, 0xc0000000) || // IETF protocol assignments
      ipv4InRange(value, 0xffffff00, 0xc0000200) || // documentation
      ipv4InRange(value, 0xfffe0000, 0xc6120000) || // benchmark
      ipv4InRange(value, 0xffffff00, 0xc6336400) || // documentation
      ipv4InRange(value, 0xffffff00, 0xcb007100) || // documentation
      ipv4InRange(value, 0xf0000000, 0xe0000000) // multicast/reserved
    );
  }
  if (isIP(normalized) === 6) {
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return normalized === "::" || normalized === "::1"
      || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("ff")
      || normalized.startsWith("2001:db8:");
  }
  return true;
}

type SafeFeedTarget = { url: URL; address: string; family: 4 | 6 };

async function resolveSafeFeedUrl(value: string): Promise<SafeFeedTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid feed URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Feed URL must be an unauthenticated HTTP(S) URL");
  }
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
    throw new Error("Feed URL uses a disallowed port");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Feed URL resolves to a private host");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Feed URL resolves to a private or reserved address");
  }
  const selected = addresses[0];
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export async function assertSafeFeedUrl(value: string): Promise<URL> {
  return (await resolveSafeFeedUrl(value)).url;
}

function requestFeed(target: SafeFeedTarget, timeoutMs: number, accept = "application/rss+xml, application/atom+xml, application/xml, text/xml"): Promise<IncomingMessage> {
  const transport = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = transport(target.url, {
      headers: {
        "User-Agent": "second-brain-rss/1.0",
        Accept: accept,
        "Accept-Encoding": "identity",
      },
      // Happy Eyeballs (autoSelectFamily, on by default since Node 20) expects a
      // lookup callback that can return multiple addresses and breaks our
      // single-address DNS pin (anti-rebinding) with ERR_INVALID_IP_ADDRESS.
      // Disable it so the single resolved address below is used as-is.
      // Not in @types/node's http.RequestOptions (it's a net.connect option
      // Node forwards through), hence the `as` below.
      autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    } as RequestOptions & { autoSelectFamily?: boolean }, resolve);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Feed request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function responseText(response: IncomingMessage, maxBytes: number) {
  const declared = Number(response.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Feed response is too large");
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of response) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      response.destroy();
      throw new Error("Feed response is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchPublicText(url: string, timeoutMs: number, accept: string, maxBytes = MAX_FEED_BYTES) {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const target = await resolveSafeFeedUrl(current);
    const res = await requestFeed(target, timeoutMs, accept);
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      res.resume();
      if (redirects === MAX_REDIRECTS) throw new Error("Too many feed redirects");
      const location = res.headers.location;
      if (!location) throw new Error("Feed redirect has no location");
      current = new URL(location, target.url).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`HTTP ${status}`);
    }
    return {
      text: await responseText(res, maxBytes),
      contentType: String(res.headers["content-type"] || "").toLowerCase(),
      url: target.url.toString(),
    };
  }
  throw new Error("Too many feed redirects");
}

export async function fetchFeed(url: string, timeoutMs = 15000): Promise<FeedItem[]> {
  return parseFeed((await fetchPublicText(url, timeoutMs, "application/rss+xml, application/atom+xml, application/xml, text/xml")).text);
}

export async function fetchJobSource(url: string, timeoutMs = 15000): Promise<FeedItem[]> {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    throw new Error("LinkedIn interdit la collecte automatisée ; utilisez une alerte e-mail LinkedIn.");
  }
  const response = await fetchPublicText(url, timeoutMs, "application/json, application/feed+json, text/html, application/xhtml+xml, application/rss+xml, application/atom+xml, application/xml, text/xml", MAX_JOB_SOURCE_BYTES);
  const startsLikeJson = /^[\[{]/.test(response.text.trimStart());
  if (response.contentType.includes("json") || startsLikeJson) return parseJobJson(response.text, response.url);
  if (response.contentType.includes("html") || /<!doctype html|<html\b/i.test(response.text)) {
    const items = parseJobPage(response.text, response.url);
    if (!items.length) throw new Error("Cette page ne publie pas d’offres structurées Schema.org.");
    return items;
  }
  return parseFeed(response.text);
}

export function parseJobPage(html: string, baseUrl: string): FeedItem[] {
  const jobs: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectJobPostings(JSON.parse(match[1]), jobs);
    } catch {
      continue;
    }
  }
  return uniqueJobItems(jobs.map((job) => jobItem(job, baseUrl)));
}

export function parseJobJson(json: string, baseUrl: string): FeedItem[] {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    throw new Error("Source JSON invalide");
  }
  const schemaJobs: Record<string, unknown>[] = [];
  collectJobPostings(root, schemaJobs);
  if (schemaJobs.length) return uniqueJobItems(schemaJobs.map((job) => jobItem(job, baseUrl)));

  const record = objectValue(root);
  const groups = Array.isArray(root)
    ? [root]
    : [record.jobs, record.items, record.results, record.postings].filter(Array.isArray) as unknown[][];
  return uniqueJobItems(groups.flat().map((item) => jobItem(objectValue(item), baseUrl)));
}

function collectJobPostings(value: unknown, jobs: Record<string, unknown>[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectJobPostings(item, jobs);
    return;
  }
  const record = objectValue(value);
  if (!Object.keys(record).length) return;
  const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
  if (types.includes("JobPosting")) jobs.push(record);
  for (const nested of Object.values(record)) if (nested && typeof nested === "object") collectJobPostings(nested, jobs);
}

function jobItem(job: Record<string, unknown>, baseUrl: string): FeedItem | null {
  if (job.isListed === false) return null;
  const categories = objectValue(job.categories);
  const identifier = objectValue(job.identifier);
  const rawLocation = objectValue(job.location);
  const link = publicLink(firstText(job.url, job.absolute_url, job.hostedUrl, job.apply_url, job.application_url, job.jobUrl, job.applyUrl, job.shortlink, job["@id"]), baseUrl);
  const id = firstText(identifier.value, job.id, job.shortcode, link);
  const title = firstText(job.title, job.text, job.name);
  if (!id || !link || !title) return null;
  const organization = objectValue(job.hiringOrganization);
  const company = firstText(organization.name, objectValue(job.company).name, job.company_name, sourceCompany(baseUrl));
  const location = firstText(jobLocation(job.jobLocation), rawLocation.name, rawLocation.city, job.city, job.state, job.country, job.location, categories.location, sourceSearchLocation(baseUrl));
  const published = jobDate(job.datePosted ?? job.published_on ?? job.publishedAt ?? job.created_at ?? job.updated_at ?? job.createdAt);
  const summary = clean(firstText(job.description, job.descriptionPlain, job.content_text, job.content, job.summary, job.additionalPlain)).slice(0, 400);
  return {
    id,
    title,
    link,
    published: published || undefined,
    summary: summary || undefined,
    company: company || undefined,
    location: location || undefined,
    source: jobSourceName(baseUrl),
  };
}

function jobLocation(value: unknown): string {
  const locations = Array.isArray(value) ? value : [value];
  return locations.map((entry) => {
    const place = objectValue(entry);
    const address = objectValue(place.address);
    return firstText(address.addressLocality, address.addressRegion, place.name, entry);
  }).filter(Boolean).join(" · ");
}

function jobDate(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1_000 : value).toISOString();
  return textValue(value);
}

function publicLink(value: string, baseUrl: string) {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function uniqueJobItems(items: Array<FeedItem | null>) {
  const unique = new Map<string, FeedItem>();
  for (const item of items) if (item && !unique.has(item.link)) unique.set(item.link, item);
  return [...unique.values()];
}

function jobSourceName(baseUrl: string) {
  const host = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, "");
  if (host.endsWith("greenhouse.io")) return "Greenhouse";
  if (host.endsWith("lever.co")) return "Lever";
  if (host.endsWith("workable.com")) return "Workable";
  if (host.endsWith("ashbyhq.com")) return "Ashby";
  return host;
}

function sourceSearchLocation(baseUrl: string) {
  try {
    return new URL(baseUrl).searchParams.get("location") || "";
  } catch {
    return "";
  }
}

function sourceCompany(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    const match = host.endsWith("greenhouse.io") ? url.pathname.match(/\/boards\/([^/]+)/)
      : host.endsWith("lever.co") ? url.pathname.match(/\/postings\/([^/]+)/)
        : host.endsWith("workable.com") ? url.pathname.match(/\/accounts\/([^/]+)/)
          : host.endsWith("ashbyhq.com") ? url.pathname.match(/\/job-board\/([^/]+)/)
            : null;
    return match ? decodeURIComponent(match[1]).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "";
  } catch {
    return "";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return "";
}

export function parseFeed(xml: string): FeedItem[] {
  const blocks = xml.match(ITEM_RE) || [];
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = clean(tag(block, "title"));
    const link = clean(extractLink(block));
    const id = clean(tag(block, "guid") || tag(block, "id")) || link;
    const published = clean(tag(block, "pubDate") || tag(block, "published") || tag(block, "updated"));
    const summary = clean(tag(block, "description") || tag(block, "summary"));
    if (!id && !link) continue;
    items.push({
      id,
      title,
      link,
      published: published ? normalizeDate(published) : undefined,
      summary: summary ? stripHtml(summary).slice(0, 400) : undefined,
    });
  }
  return items;
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? match[1] : "";
}

function extractLink(block: string): string {
  const text = tag(block, "link").trim();
  if (text) return text;
  // Atom: <link rel="alternate" href="..."/> — prefer alternate, fall back to first href.
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const alternate = links.find((l) => /rel=["']?alternate/i.test(l)) || links.find((l) => !/rel=/i.test(l)) || links[0];
  const href = alternate?.match(/href=["']([^"']+)["']/i);
  return href ? href[1] : "";
}

function clean(value: string): string {
  return decodeEntities(stripCdata(value)).trim();
}

function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function normalizeDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
