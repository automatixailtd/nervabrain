import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createApplication,
  createApplicationDocument,
  deleteApplicationDocument,
  jobWatchIdentity,
  linkApplicationDocument,
  listApplicationRecords,
  listTrash,
  matchesJobWatch,
  readJobWatchSettings,
  saveJobWatchSettings,
  updateApplication,
  updateNote,
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
  const document = await createApplicationDocument({ name: "CV DevOps", kind: "cv", url: "https://www.canva.com/design/cv", version: "v3", applicationPath: application.relativePath });

  assert.equal(application.relativePath.startsWith("13-Applications/"), true);
  assert.equal(application.data.stage, "new");
  assert.match(application.content, /\[CV\]\(https:\/\/www\.canva\.com\/design\/cv\)/);

  const renamed = await updateNote({ relativePath: application.relativePath, title: "Infomaniak · Senior SRE", content: application.content });
  assert.equal(renamed.data.company, "Infomaniak");
  assert.equal(renamed.data.role, "Senior SRE");
  const roleOnly = await updateNote({ relativePath: application.relativePath, title: "Platform Engineer", content: renamed.content });
  assert.equal(roleOnly.title, "Infomaniak · Platform Engineer");
  assert.equal(roleOnly.data.role, "Platform Engineer");
  assert.deepEqual((await listApplicationRecords()).find((note) => note.relativePath === application.relativePath)?.data.document_paths, [document.relativePath]);

  await linkApplicationDocument(application.relativePath, document.relativePath, false);
  assert.deepEqual((await listApplicationRecords()).find((note) => note.relativePath === application.relativePath)?.data.document_paths, []);
  await linkApplicationDocument(application.relativePath, document.relativePath);

  const submitted = await updateApplicationStage(application.relativePath, "applied");
  const interviewed = await updateApplicationStage(application.relativePath, "interview");
  assert.match(String(submitted?.data.applied_on), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(interviewed?.data.applied_on, submitted?.data.applied_on);
  assert.deepEqual((await listApplicationRecords()).map((note) => note.data.record_type).sort(), ["application", "document"]);

  const edited = await updateApplication(application.relativePath, {
    company: "Infomaniak Network",
    role: "Platform Engineer",
    location: "Genève · hybride",
    offerUrl: "https://example.com/jobs/platform",
    stage: "interview",
    foundOn: "2026-08-23",
    appliedOn: String(interviewed?.data.applied_on),
    nextAction: "Préparer l’entretien",
    nextActionDate: "2026-08-28",
    cvUrl: "https://www.canva.com/design/cv-v4",
    coverLetterUrl: "https://docs.google.com/document/d/letter-v2",
    notes: "Échange avec l’équipe plateforme.",
  });
  assert.equal(edited?.title, "Infomaniak Network · Platform Engineer");
  assert.equal(edited?.data.location, "Genève · hybride");
  assert.equal(edited?.data.offer_url, "https://example.com/jobs/platform");
  assert.match(edited?.content || "", /\[Offre\]\(https:\/\/example\.com\/jobs\/platform\)/);
  assert.match(edited?.content || "", /Échange avec l’équipe plateforme/);

  await deleteApplicationDocument(document.relativePath);
  const remaining = await listApplicationRecords();
  assert.deepEqual(remaining.map((note) => note.data.record_type), ["application"]);
  assert.deepEqual(remaining[0]?.data.document_paths, []);
  assert.equal((await listTrash())[0]?.from, document.relativePath);
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
  assert.equal(matchesJobWatch({ title: "Ingénieur SRE", location: "Genève", summary: "Poste hybride" }, settings), true);
  assert.equal(matchesJobWatch({ title: "Stage SRE — Genève", summary: "Remote" }, settings), false);
  assert.equal(matchesJobWatch({ title: "SRE — Paris", summary: "Sur site" }, settings), false);

  const titleFiltered = { ...settings, excludedKeywords: ["title:lead", "title:responsable"] };
  assert.equal(matchesJobWatch({ title: "Tech Lead — Cloud", location: "Genève", summary: "Poste hybride" }, titleFiltered), false);
  assert.equal(matchesJobWatch({ title: "Responsable DevOps", location: "Genève", summary: "Poste hybride" }, titleFiltered), false);
  assert.equal(matchesJobWatch({ title: "SRE Kubernetes — Genève", summary: "Lead technique ponctuel, poste hybride" }, titleFiltered), true);

  const saved = await readJobWatchSettings();
  assert.deepEqual(saved.feeds, ["https://example.com/jobs.xml"]);
  assert.deepEqual(saved.locations, ["Genève"]);
  assert.equal(
    jobWatchIdentity({ title: "DevOps Engineer", company: "Pictet", location: "Genève" }),
    jobWatchIdentity({ title: "devops engineer", company: "Pictet", location: "Geneve" }),
  );
  assert.equal(
    jobWatchIdentity({ title: "Site Reliability Engineer (SRE) - Database and Monitoring", company: "infomaniak | The Ethical Cloud", location: "Genève" }),
    jobWatchIdentity({ title: "SRE Database and Monitoring", company: "Infomaniak", location: "Suisse romande" }),
  );
}));
