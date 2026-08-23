import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createApplication,
  createApplicationDocument,
  listApplicationRecords,
  matchesJobWatch,
  readJobWatchSettings,
  saveJobWatchSettings,
  updateApplicationStage,
  type JobWatchSettings,
} from "../src/lib/vault";

async function scratchVault(run: () => Promise<void>) {
  const previous = process.env.SECOND_BRAIN_VAULT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nerva-applications-"));
  process.env.SECOND_BRAIN_VAULT = root;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.SECOND_BRAIN_VAULT;
    else process.env.SECOND_BRAIN_VAULT = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("applications keep offer and document links in Markdown and stamp submission once", () => scratchVault(async () => {
  const application = await createApplication({
    company: "Infomaniak",
    role: "Ingénieur DevOps",
    offerUrl: "https://example.com/jobs/devops",
    cvUrl: "https://www.canva.com/design/cv",
    coverLetterUrl: "https://docs.google.com/document/d/letter",
    stage: "new",
    foundOn: "2026-08-23",
  });
  await createApplicationDocument({ name: "CV DevOps", kind: "cv", url: "https://www.canva.com/design/cv", version: "v3" });

  assert.equal(application.relativePath.startsWith("13-Applications/"), true);
  assert.equal(application.data.stage, "new");
  assert.match(application.content, /\[CV\]\(https:\/\/www\.canva\.com\/design\/cv\)/);

  const submitted = await updateApplicationStage(application.relativePath, "applied");
  const interviewed = await updateApplicationStage(application.relativePath, "interview");
  assert.match(String(submitted?.data.applied_on), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(interviewed?.data.applied_on, submitted?.data.applied_on);
  assert.deepEqual((await listApplicationRecords()).map((note) => note.data.record_type).sort(), ["application", "document"]);
}));

test("job watch validates public HTTP URLs and applies inclusive filters", () => scratchVault(async () => {
  const empty = await readJobWatchSettings();
  await assert.rejects(() => saveJobWatchSettings({ ...empty, feeds: ["file:///etc/passwd"] }), /HTTP\(S\)/);

  const settings: JobWatchSettings = {
    ...empty,
    enabled: true,
    feeds: ["https://example.com/jobs.xml"],
    keywords: ["SRE", "Kubernetes"],
    excludedKeywords: ["stage"],
    locations: ["Genève"],
    remoteOnly: true,
  };
  await saveJobWatchSettings(settings);
  assert.equal(matchesJobWatch({ title: "SRE Kubernetes — Genève", summary: "Poste hybride" }, settings), true);
  assert.equal(matchesJobWatch({ title: "Stage SRE — Genève", summary: "Remote" }, settings), false);
  assert.equal(matchesJobWatch({ title: "SRE — Paris", summary: "Sur site" }, settings), false);

  const saved = await readJobWatchSettings();
  assert.deepEqual(saved.feeds, ["https://example.com/jobs.xml"]);
  assert.deepEqual(saved.locations, ["Genève"]);
}));
