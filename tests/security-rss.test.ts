import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateAddress, parseFeed, parseJobJson, parseJobPage } from "../src/lib/rss";

test("RSS SSRF guard rejects private, metadata, mapped, and reserved addresses", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1", "::ffff:c0a8:101",
  ]) assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress("1.1.1.1"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("RSS parser still handles Atom links after transport hardening", () => {
  const items = parseFeed(`<?xml version="1.0"?><feed><entry><id>one</id><title>Hello</title><link rel="alternate" href="https://example.com/one"/><summary>Useful</summary></entry></feed>`);
  assert.equal(items.length, 1);
  assert.equal(items[0].link, "https://example.com/one");
});

test("structured job page parser reads Schema.org JobPosting data on any public site", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@graph": [{
      "@type": ["Thing", "JobPosting"],
      title: "Ingénieur DevOps",
      description: "Plateforme Kubernetes",
      identifier: { value: "job-123" },
      datePosted: "2026-08-27T08:00:00+02:00",
      hiringOrganization: { name: "Example SA" },
      jobLocation: { address: { addressLocality: "Genève" } },
      url: "/jobs/job-123",
    }],
  })}</script>`;

  assert.deepEqual(parseJobPage(html, "https://careers.example.com/openings"), [{
    id: "job-123",
    title: "Ingénieur DevOps",
    link: "https://careers.example.com/jobs/job-123",
    published: "2026-08-27T08:00:00+02:00",
    summary: "Plateforme Kubernetes",
    company: "Example SA",
    location: "Genève",
    source: "careers.example.com",
  }]);
});

test("public ATS JSON parser handles Greenhouse, Lever, Workable, and Ashby shapes", () => {
  const greenhouse = parseJobJson(JSON.stringify({ jobs: [{
    id: 42,
    title: "Platform Engineer",
    absolute_url: "https://boards.greenhouse.io/acme/jobs/42",
    updated_at: "2026-08-27T08:00:00Z",
    location: { name: "Lausanne" },
    content: "Cloud platform",
  }] }), "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true");
  const lever = parseJobJson(JSON.stringify([{
    id: "lever-1",
    text: "Site Reliability Engineer",
    hostedUrl: "https://jobs.lever.co/acme/lever-1",
    createdAt: 1787817600000,
    categories: { location: "Genève" },
    descriptionPlain: "Reliable systems",
  }]), "https://api.lever.co/v0/postings/acme?mode=json");
  const workable = parseJobJson(JSON.stringify({ jobs: [{
    shortcode: "workable-1",
    title: "Cloud Engineer",
    url: "https://apply.workable.com/acme/j/workable-1/",
    published_on: "2026-08-27",
    location: { city: "Lausanne" },
  }] }), "https://www.workable.com/api/accounts/acme?details=true");
  const ashby = parseJobJson(JSON.stringify({ jobs: [{
    id: "ashby-hidden",
    title: "Hidden",
    jobUrl: "https://jobs.ashbyhq.com/acme/hidden",
    isListed: false,
  }, {
    id: "ashby-1",
    title: "Infrastructure Engineer",
    jobUrl: "https://jobs.ashbyhq.com/acme/ashby-1",
    publishedAt: "2026-08-27T08:00:00Z",
    location: "Genève",
    isListed: true,
  }] }), "https://api.ashbyhq.com/posting-api/job-board/acme");

  assert.deepEqual([
    [greenhouse[0]?.source, greenhouse[0]?.company, greenhouse[0]?.title, greenhouse[0]?.location],
    [lever[0]?.source, lever[0]?.company, lever[0]?.title, lever[0]?.location],
    [workable[0]?.source, workable[0]?.company, workable[0]?.title, workable[0]?.location],
    [ashby[0]?.source, ashby[0]?.company, ashby[0]?.title, ashby[0]?.location],
  ], [
    ["Greenhouse", "Acme", "Platform Engineer", "Lausanne"],
    ["Lever", "Acme", "Site Reliability Engineer", "Genève"],
    ["Workable", "Acme", "Cloud Engineer", "Lausanne"],
    ["Ashby", "Acme", "Infrastructure Engineer", "Genève"],
  ]);
});
