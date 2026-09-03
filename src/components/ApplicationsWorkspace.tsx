"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import {
  BellRing,
  BrainCircuit,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderOpen,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import {
  createApplicationAction,
  createApplicationDocumentAction,
  deleteApplicationDocumentAction,
  linkApplicationDocumentAction,
  refreshJobFeedsAction,
  saveJobWatchSettingsAction,
  updateApplicationAction,
  updateApplicationStageAction,
} from "@/app/actions";
import { CustomSelect } from "@/components/CustomSelect";
import { DatePicker } from "@/components/DatePicker";
import { MetricCards } from "@/components/ui/Analytics";
import { useLanguage } from "@/components/LanguageProvider";
import { matchesBusinessSearch } from "@/lib/business-view";
import type { TranslationKey } from "@/lib/i18n";
import type { JobWatchSettings, VaultNote } from "@/lib/vault";

const APPLICATION_STAGES = ["new", "preparing", "applied", "interview", "offer", "accepted", "rejected", "withdrawn", "ignored"] as const;
type ApplicationStage = (typeof APPLICATION_STAGES)[number];
type ApplicationStageFilter = "active" | "all" | ApplicationStage;
const ACTIVE_APPLICATION_STAGES = new Set<ApplicationStage>(["new", "preparing", "applied", "interview", "offer"]);
const APPLICATION_DOCUMENT_KINDS = ["cv", "cover_letter", "portfolio", "other"] as const;
type ApplicationDocumentKind = (typeof APPLICATION_DOCUMENT_KINDS)[number];

type Tab = "pipeline" | "offers" | "documents" | "sources";
type Modal = "application" | "document" | null;
type ApplicationView = "compact" | "detailed";
type ActionResult = { ok: boolean; error?: string };

type Application = {
  path: string;
  title: string;
  company: string;
  role: string;
  location: string;
  stage: ApplicationStage;
  offerUrl: string;
  source: string;
  sourceUrl: string;
  foundOn: string;
  appliedOn: string;
  nextAction: string;
  nextActionDate: string;
  cvUrl: string;
  coverLetterUrl: string;
  contactName: string;
  contactEmail: string;
  notes: string;
  documentPaths: string[];
};

type Document = {
  path: string;
  name: string;
  kind: ApplicationDocumentKind;
  url: string;
  version: string;
};

function value(input: unknown) {
  return input === undefined || input === null ? "" : String(input);
}

function noteLink(relativePath: string) {
  return "/note/" + relativePath.split("/").map(encodeURIComponent).join("/");
}

function prepareLink(relativePath: string) {
  return `/assistant?prepare=${encodeURIComponent(relativePath)}`;
}

function companyInitials(company: string) {
  const words = company.trim().split(/\s+/).filter(Boolean);
  return words.length ? words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() : "•";
}

function applicationSource(application: Application) {
  const url = application.offerUrl || application.sourceUrl;
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* no public source URL */ }
  const stored = ["manual", "mcp", "vault"].includes(application.source.toLowerCase()) ? "" : application.source;
  const label = host.endsWith("linkedin.com") ? "LinkedIn" : host === "jobup.ch" || host.endsWith(".jobup.ch") ? "JobUp" : stored || host;
  return label ? { host, label } : null;
}

function applicationNotes(content: string) {
  return content.match(/(?:^|\n)## Notes\s*\n([\s\S]*)$/)?.[1]?.trim() || "";
}

function ApplicationSource({ source }: { source: { host: string; label: string } }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="applications-source">
      {source.host && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(source.host)}&sz=64`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : <ExternalLink size={12} aria-hidden />}
      {source.label}
    </span>
  );
}

function applicationFromNote(note: VaultNote): Application | null {
  if (value(note.data.record_type) !== "application") return null;
  const rawStage = value(note.data.stage);
  const stage = APPLICATION_STAGES.includes(rawStage as ApplicationStage) ? rawStage as ApplicationStage : "new";
  return {
    path: note.relativePath,
    title: note.title,
    company: value(note.data.company),
    role: value(note.data.role) || note.title,
    location: value(note.data.location),
    stage,
    offerUrl: value(note.data.offer_url),
    source: value(note.data.source),
    sourceUrl: value(note.data.source_url),
    foundOn: value(note.data.found_on),
    appliedOn: value(note.data.applied_on),
    nextAction: value(note.data.next_action),
    nextActionDate: value(note.data.next_action_date),
    cvUrl: value(note.data.cv_url),
    coverLetterUrl: value(note.data.cover_letter_url),
    contactName: value(note.data.contact_name),
    contactEmail: value(note.data.contact_email),
    notes: applicationNotes(note.content),
    documentPaths: Array.isArray(note.data.document_paths) ? note.data.document_paths.map(String) : [],
  };
}

function documentFromNote(note: VaultNote): Document | null {
  if (value(note.data.record_type) !== "document") return null;
  const rawKind = value(note.data.document_kind);
  return {
    path: note.relativePath,
    name: note.title,
    kind: APPLICATION_DOCUMENT_KINDS.includes(rawKind as ApplicationDocumentKind) ? rawKind as ApplicationDocumentKind : "other",
    url: value(note.data.document_url),
    version: value(note.data.version),
  };
}

function ExternalButton({ href, children }: { href: string; children: React.ReactNode }) {
  if (!href) return null;
  return <a className="applications-link" href={href} target="_blank" rel="noreferrer">{children}<ExternalLink size={13} aria-hidden /></a>;
}

export function additionalApplicationDocuments<T extends { url: string }>(documents: T[], primaryUrls: string[]) {
  const primary = new Set(primaryUrls.filter(Boolean));
  return documents.filter((document) => !primary.has(document.url));
}

function ApplicationModal({ kind, today, applications, application, onClose }: { kind: Exclude<Modal, null>; today: string; applications: Application[]; application?: Application | null; onClose: () => void }) {
  const { locale, t } = useLanguage();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [stage, setStage] = useState<ApplicationStage>(application?.stage || "preparing");
  const [documentKind, setDocumentKind] = useState<ApplicationDocumentKind>("cv");
  const [foundOn, setFoundOn] = useState(application?.foundOn || today);
  const [appliedOn, setAppliedOn] = useState(application?.appliedOn || "");
  const [nextActionDate, setNextActionDate] = useState(application?.nextActionDate || "");
  const stageOptions = APPLICATION_STAGES.filter((item) => application || item !== "ignored").map((item) => ({ value: item, label: t(`applications.stage.${item}` as TranslationKey) }));
  const documentOptions = APPLICATION_DOCUMENT_KINDS.map((item) => ({ value: item, label: t(`applications.document.${item}` as TranslationKey) }));
  const applicationOptions = [{ value: "", label: t("applications.document.unlinked") }, ...applications.map((item) => ({ value: item.path, label: `${item.company || t("applications.companyUnknown")} · ${item.role}` }))];

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(".applications-dialog .custom-select.is-open")) onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      const result: ActionResult = kind === "document"
        ? await createApplicationDocumentAction(data)
        : application
          ? await updateApplicationAction(data)
          : await createApplicationAction(data);
      if (!result.ok) return setError(result.error || t("applications.error.save"));
      router.refresh();
      onClose();
    });
  }

  return (
    <div className="applications-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="applications-dialog" role="dialog" aria-modal="true" aria-labelledby="applications-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="eyebrow">{t("applications.eyebrow")}</span><h2 id="applications-dialog-title">{t(kind === "document" ? "applications.document.new" : application ? "applications.editTitle" : "applications.new")}</h2></div>
          <button type="button" onClick={onClose} aria-label={t("common.close")}><X size={18} aria-hidden /></button>
        </header>
        <form className="applications-form" onSubmit={submit}>
          {kind === "application" ? (
            <>
              {application ? <input name="path" type="hidden" value={application.path} /> : null}
              <div className="applications-form-grid">
                <label>{t("applications.field.company")}<input name="company" autoFocus defaultValue={application?.company} placeholder={t("applications.placeholder.company")} /></label>
                <label>{t("applications.field.role")}<input name="role" required defaultValue={application?.role} placeholder={t("applications.placeholder.role")} /></label>
                <label>{t("applications.field.location")}<input name="location" defaultValue={application?.location} placeholder={t("applications.placeholder.location")} /></label>
                <label>{t("applications.field.stage")}<CustomSelect name="stage" options={stageOptions} value={stage} onChange={(next) => setStage(next as ApplicationStage)} /></label>
                <label>{t("applications.field.foundOn")}<DatePicker name="foundOn" value={foundOn} onChange={setFoundOn} locale={locale} /></label>
                <label>{t("applications.field.appliedOn")}<DatePicker name="appliedOn" value={appliedOn} onChange={setAppliedOn} locale={locale} /></label>
              </div>
              <label>{t("applications.field.offerUrl")}<input name="offerUrl" type="url" defaultValue={application?.offerUrl} placeholder="https://…" /></label>
              <div className="applications-form-grid">
                <label>{t("applications.field.cvUrl")}<input name="cvUrl" type="url" defaultValue={application?.cvUrl} placeholder="https://www.canva.com/…" /></label>
                <label>{t("applications.field.coverLetterUrl")}<input name="coverLetterUrl" type="url" defaultValue={application?.coverLetterUrl} placeholder="https://docs.google.com/…" /></label>
                <label>{t("applications.field.nextAction")}<input name="nextAction" defaultValue={application?.nextAction} placeholder={t("applications.placeholder.nextAction")} /></label>
                <label>{t("applications.field.nextActionDate")}<DatePicker name="nextActionDate" value={nextActionDate} onChange={setNextActionDate} locale={locale} /></label>
                <label>{t("applications.field.contactName")}<input name="contactName" defaultValue={application?.contactName} /></label>
                <label>{t("applications.field.contactEmail")}<input name="contactEmail" type="email" defaultValue={application?.contactEmail} /></label>
              </div>
              <label>{t("applications.field.notes")}<textarea name="notes" rows={4} defaultValue={application?.notes} /></label>
            </>
          ) : (
            <>
              <div className="applications-form-grid">
                <label>{t("applications.field.documentName")}<input name="name" autoFocus required placeholder={t("applications.placeholder.documentName")} /></label>
                <label>{t("applications.field.documentKind")}<CustomSelect name="kind" options={documentOptions} value={documentKind} onChange={(next) => setDocumentKind(next as ApplicationDocumentKind)} /></label>
                <label>{t("applications.field.version")}<input name="version" placeholder={t("applications.placeholder.version")} /></label>
                <label>{t("applications.field.linkedApplication")}<CustomSelect name="applicationPath" options={applicationOptions} defaultValue="" searchable /></label>
              </div>
              <label>{t("applications.field.documentUrl")}<input name="url" required type="url" placeholder="https://…" /></label>
              <label>{t("applications.field.notes")}<textarea name="notes" rows={4} /></label>
            </>
          )}
          {error ? <p className="applications-form-error" role="alert">{error}</p> : null}
          <footer><button className="button secondary" type="button" onClick={onClose}>{t("common.cancel")}</button><button className="button primary" type="submit" disabled={pending}>{pending ? t("applications.saving") : t("applications.save")}</button></footer>
        </form>
      </section>
    </div>
  );
}

function ApplicationRow({ application, documents, today, pending, compact, onStage, onEdit }: { application: Application; documents: Document[]; today: string; pending: boolean; compact: boolean; onStage: (path: string, stage: string) => void; onEdit: (application: Application) => void }) {
  const { locale, t } = useLanguage();
  const stageOptions = APPLICATION_STAGES.map((item) => ({ value: item, label: t(`applications.stage.${item}` as TranslationKey) }));
  const formatDate = (date: string) => date ? new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00Z`)) : t("applications.noDate");
  const due = application.nextActionDate && application.nextActionDate <= today && !["accepted", "rejected", "withdrawn", "ignored"].includes(application.stage);
  const source = applicationSource(application);
  const additionalDocuments = additionalApplicationDocuments(documents, [application.offerUrl, application.cvUrl, application.coverLetterUrl]);
  return (
    <article className={`applications-row${compact ? " is-compact" : ""}`}>
      <div className="applications-identity"><span className="applications-company-mark" aria-hidden>{companyInitials(application.company)}</span><div className="applications-role">{application.offerUrl ? <a href={application.offerUrl} target="_blank" rel="noreferrer">{application.role}</a> : <button type="button" onClick={() => onEdit(application)}>{application.role}</button>}<div className="applications-company-meta"><span>{application.company || t("applications.companyUnknown")}{application.location ? <> · <MapPin size={11} aria-hidden /> {application.location}</> : null}</span>{source ? <ApplicationSource source={source} /> : null}</div></div></div>
      <div className="applications-stage-cell"><CustomSelect name="stage" options={stageOptions} value={application.stage} onChange={(stage) => onStage(application.path, stage)} disabled={pending} /></div>
      <div className={`applications-next-cell${due ? " is-due" : ""}`}><strong>{application.nextAction || t("applications.noNextAction")}</strong><span>{formatDate(application.nextActionDate || application.appliedOn || application.foundOn)}</span></div>
      {compact ? <div className="applications-compact-actions">
        <Link className="applications-link" href={prepareLink(application.path)} title={t("applications.prepare")}><BrainCircuit size={15} aria-hidden /><span className="sr-only">{t("applications.prepare")}</span></Link>
        <button className="applications-link" type="button" onClick={() => onEdit(application)} title={t("applications.edit")}><Pencil size={15} aria-hidden /><span className="sr-only">{t("applications.edit")}</span></button>
      </div> : <div className="applications-links">
        <Link className="applications-link" href={prepareLink(application.path)}><BrainCircuit size={13} aria-hidden />{t("applications.prepare")}</Link>
        <button className="applications-link" type="button" onClick={() => onEdit(application)}><Pencil size={13} aria-hidden />{t("applications.edit")}</button>
        <ExternalButton href={application.offerUrl}>{t("applications.link.offer")}</ExternalButton>
        <ExternalButton href={application.cvUrl}>{t("applications.link.cv")}</ExternalButton>
        <ExternalButton href={application.coverLetterUrl}>{t("applications.link.letter")}</ExternalButton>
        {additionalDocuments.map((document) => <ExternalButton href={document.url} key={document.path}>{document.name}</ExternalButton>)}
      </div>}
    </article>
  );
}

export function ApplicationsWorkspace({ records, watch, today }: { records: VaultNote[]; watch: JobWatchSettings; today: string }) {
  const { locale, t } = useLanguage();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("pipeline");
  const [modal, setModal] = useState<Modal>(null);
  const [editingApplication, setEditingApplication] = useState<Application | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<Document | null>(null);
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<ApplicationStageFilter>("active");
  const [applicationView, setApplicationView] = useState<ApplicationView>("compact");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const modalTrigger = useRef<HTMLElement | null>(null);
  const applications = useMemo(() => records.map(applicationFromNote).filter((item): item is Application => Boolean(item)), [records]);
  const documents = useMemo(() => records.map(documentFromNote).filter((item): item is Document => Boolean(item)), [records]);
  const newOffers = applications.filter((item) => item.stage === "new");
  const activeApplications = applications.filter((item) => ACTIVE_APPLICATION_STAGES.has(item.stage));
  const pipeline = stageFilter === "active" ? activeApplications : stageFilter === "all" ? applications : applications.filter((item) => item.stage === stageFilter);
  const visible = (tab === "offers" ? newOffers : pipeline).filter((item) => matchesBusinessSearch(`${item.company} ${item.role} ${item.location} ${item.nextAction}`, query));
  const due = applications.filter((item) => item.nextActionDate && item.nextActionDate <= today && !["accepted", "rejected", "withdrawn", "ignored"].includes(item.stage));
  const sent = applications.filter((item) => ["applied", "interview", "offer", "accepted", "rejected"].includes(item.stage));
  const interviews = applications.filter((item) => item.stage === "interview").length;
  const filterOptions = [
    { value: "active", label: t("applications.filter.active") },
    { value: "all", label: t("applications.filter.all") },
    ...APPLICATION_STAGES.map((item) => ({ value: item, label: t(`applications.stage.${item}` as TranslationKey) })),
  ];

  function openModal(next: Exclude<Modal, null>) {
    modalTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingApplication(null);
    setModal(next);
  }

  function editApplication(application: Application) {
    modalTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingApplication(application);
    setModal("application");
  }

  function closeModal() {
    setModal(null);
    setEditingApplication(null);
    window.requestAnimationFrame(() => modalTrigger.current?.focus());
  }

  function updateStage(path: string, stage: string) {
    const data = new FormData();
    data.set("path", path);
    data.set("stage", stage);
    setMessage("");
    startTransition(async () => {
      const result = await updateApplicationStageAction(data);
      if (!result.ok) setMessage(result.error || t("applications.error.update"));
      else router.refresh();
    });
  }

  function setDocumentLink(applicationPath: string, documentPath: string, linked: boolean) {
    const data = new FormData();
    data.set("applicationPath", applicationPath);
    data.set("documentPath", documentPath);
    data.set("linked", String(linked));
    setMessage("");
    startTransition(async () => {
      const result = await linkApplicationDocumentAction(data);
      if (!result.ok) setMessage(result.error || t("applications.error.documentLink"));
      else router.refresh();
    });
  }

  function deleteDocument(document: Document) {
    setDocumentToDelete(null);
    const data = new FormData();
    data.set("path", document.path);
    setMessage("");
    startTransition(async () => {
      const result = await deleteApplicationDocumentAction(data);
      if (!result.ok) setMessage(result.error || t("applications.error.documentDelete"));
      else router.refresh();
    });
  }

  function saveSources(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setMessage("");
    startTransition(async () => {
      const result = await saveJobWatchSettingsAction(data);
      setMessage(result.ok ? t("applications.sources.saved") : result.error || t("applications.error.sources"));
      if (result.ok) router.refresh();
    });
  }

  function refreshSources() {
    setMessage("");
    startTransition(async () => {
      const result = await refreshJobFeedsAction();
      setMessage(result.ok ? t("applications.sources.added").replace("{count}", String(result.added)) : result.error || t("applications.error.refresh"));
      if (result.ok) router.refresh();
    });
  }

  const tabs: Array<{ value: Tab; label: TranslationKey; icon: React.ReactNode; count?: number }> = [
    { value: "pipeline", label: "applications.tab.pipeline", icon: <BriefcaseBusiness size={16} />, count: activeApplications.length },
    { value: "offers", label: "applications.tab.offers", icon: <BellRing size={16} />, count: newOffers.length },
    { value: "documents", label: "applications.tab.documents", icon: <FolderOpen size={16} />, count: documents.length },
    { value: "sources", label: "applications.tab.sources", icon: <Settings2 size={16} /> },
  ];
  const lastRun = watch.lastRun ? new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(watch.lastRun)) : t("applications.sources.never");

  return (
    <main className="applications-workspace">
      <header className="applications-hero">
        <div><span className="eyebrow">{t("applications.eyebrow")}</span><h1>{t("applications.title")}</h1><p>{t("applications.description")}</p></div>
        <div className="applications-hero-actions"><button className="button secondary" type="button" onClick={() => openModal("document")}><FileText size={16} aria-hidden />{t("applications.document.new")}</button><button className="button primary" type="button" onClick={() => openModal("application")}><Plus size={16} aria-hidden />{t("applications.new")}</button></div>
      </header>

      <MetricCards className="applications-metrics" items={[
        { label: t("applications.metric.active"), value: activeApplications.length, detail: t("applications.metric.activeDetail"), icon: <BriefcaseBusiness size={15} />, tone: "accent" },
        { label: t("applications.metric.sent"), value: sent.length, detail: t("applications.metric.sentDetail"), icon: <Send size={15} />, tone: "info" },
        { label: t("applications.metric.interviews"), value: interviews, detail: t("applications.metric.interviewsDetail"), icon: <CheckCircle2 size={15} />, tone: "positive" },
        { label: t("applications.metric.due"), value: due.length, detail: t("applications.metric.dueDetail"), icon: <CalendarClock size={15} />, tone: due.length ? "warning" : "neutral" },
      ]} />

      <nav className="applications-tabs" aria-label={t("applications.tabsLabel")}>{tabs.map((item) => <button className={tab === item.value ? "is-active" : ""} type="button" key={item.value} onClick={() => setTab(item.value)}>{item.icon}{t(item.label)}{item.count !== undefined ? <b>{item.count}</b> : null}</button>)}</nav>

      {(tab === "pipeline" || tab === "offers") ? (
        <section className="applications-list-section">
          <header><div><span className="eyebrow">{t(tab === "offers" ? "applications.offers.eyebrow" : "applications.pipeline.eyebrow")}</span><h2>{t(tab === "offers" ? "applications.offers.title" : "applications.pipeline.title")}</h2><p>{t(tab === "offers" ? "applications.offers.description" : "applications.pipeline.description")}</p></div></header>
          <div className="applications-list-tools"><label className="applications-search"><Search size={16} aria-hidden /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("applications.search")} /></label>{tab === "pipeline" ? <><label className="applications-stage-filter"><span>{t("workspace.status")}</span><CustomSelect name="application-status-filter" options={filterOptions} value={stageFilter} onChange={(value) => setStageFilter(value as ApplicationStageFilter)} /></label><div className="segmented-control applications-view-toggle" role="group" aria-label={t("applications.view.label")}><button className={applicationView === "compact" ? "is-active" : ""} type="button" aria-pressed={applicationView === "compact"} onClick={() => setApplicationView("compact")}>{t("applications.view.compact")}</button><button className={applicationView === "detailed" ? "is-active" : ""} type="button" aria-pressed={applicationView === "detailed"} onClick={() => setApplicationView("detailed")}>{t("applications.view.detailed")}</button></div></> : null}</div>
          {visible.length ? <><div className={`applications-row-head${tab === "pipeline" && applicationView === "compact" ? " is-compact" : ""}`}><span>{t("applications.column.role")}</span><span>{t("applications.column.stage")}</span><span>{t("applications.column.next")}</span><span>{t(tab === "pipeline" && applicationView === "compact" ? "applications.column.actions" : "applications.column.documents")}</span></div><div className="applications-rows">{visible.map((application) => <ApplicationRow application={application} documents={documents.filter((document) => application.documentPaths.includes(document.path))} today={today} pending={pending} compact={tab === "pipeline" && applicationView === "compact"} onStage={updateStage} onEdit={editApplication} key={application.path} />)}</div></> : <div className="applications-empty"><BriefcaseBusiness size={28} aria-hidden /><h3>{t(tab === "offers" ? "applications.offers.empty" : "applications.pipeline.empty")}</h3><p>{t(tab === "offers" ? "applications.offers.emptyHint" : "applications.pipeline.emptyHint")}</p>{tab === "pipeline" ? <button className="button primary" type="button" onClick={() => openModal("application")}>{t("applications.new")}</button> : null}</div>}
        </section>
      ) : null}

      {tab === "documents" ? (
        <section className="applications-list-section">
          <header><div><span className="eyebrow">{t("applications.documents.eyebrow")}</span><h2>{t("applications.documents.title")}</h2><p>{t("applications.documents.description")}</p></div><button className="button primary" type="button" onClick={() => openModal("document")}><Plus size={16} aria-hidden />{t("applications.document.new")}</button></header>
          {documents.length ? <div className="applications-documents">{documents.map((document) => {
            const linkedApplications = applications.filter((application) => application.documentPaths.includes(document.path));
            const availableApplications = applications.filter((application) => !application.documentPaths.includes(document.path));
            const linkOptions = [{ value: "", label: t("applications.document.link") }, ...availableApplications.map((application) => ({ value: application.path, label: `${application.company || t("applications.companyUnknown")} · ${application.role}` }))];
            return <article key={document.path}>
              <FileText size={20} aria-hidden />
              <div><Link href={noteLink(document.path)}>{document.name}</Link><span>{t(`applications.document.${document.kind}` as TranslationKey)}{document.version ? ` · ${document.version}` : ""}</span></div>
              <div className="applications-document-actions">
                <ExternalButton href={document.url}>{t("applications.link.open")}</ExternalButton>
                <button className="applications-link is-danger" type="button" disabled={pending} onClick={() => setDocumentToDelete(document)}><Trash2 size={13} aria-hidden />{t("trash.delete")}</button>
              </div>
              <div className="applications-document-links">
                <div>{linkedApplications.map((application) => <button type="button" disabled={pending} onClick={() => setDocumentLink(application.path, document.path, false)} aria-label={t("applications.document.unlink").replace("{name}", application.title)} key={application.path}>{application.company || application.role}<X size={12} aria-hidden /></button>)}</div>
                <CustomSelect name={`link-${document.path}`} options={linkOptions} value="" onChange={(applicationPath) => applicationPath && setDocumentLink(applicationPath, document.path, true)} disabled={pending || !availableApplications.length} searchable />
              </div>
            </article>;
          })}</div> : <div className="applications-empty"><FolderOpen size={28} aria-hidden /><h3>{t("applications.documents.empty")}</h3><p>{t("applications.documents.emptyHint")}</p></div>}
        </section>
      ) : null}

      {tab === "sources" ? (
        <section className="applications-sources"><header><div><span className="eyebrow">{t("applications.sources.eyebrow")}</span><h2>{t("applications.sources.title")}</h2><p>{t("applications.sources.description")}</p></div><button className="button secondary" type="button" onClick={refreshSources} disabled={pending || !watch.feeds.length}><RefreshCw size={16} aria-hidden />{t("applications.sources.refresh")}</button></header><form onSubmit={saveSources}><label className="applications-check"><input name="enabled" type="checkbox" defaultChecked={watch.enabled} /><span><strong>{t("applications.sources.enabled")}</strong><small>{t("applications.sources.enabledHint")}</small></span></label><div className="applications-form-grid"><label>{t("applications.sources.feeds")}<textarea name="feeds" rows={6} defaultValue={watch.feeds.join("\n")} placeholder="https://careers.example.com/jobs" /><small>{t("applications.sources.feedsHint")}</small></label><label>{t("applications.sources.keywords")}<textarea name="keywords" rows={6} defaultValue={watch.keywords.join("\n")} placeholder={t("applications.sources.keywordsPlaceholder")} /><small>{t("applications.sources.keywordsHint")}</small></label><label>{t("applications.sources.excluded")}<textarea name="excludedKeywords" rows={4} defaultValue={watch.excludedKeywords.join("\n")} /><small>{t("applications.sources.excludedHint")}</small></label><label>{t("applications.sources.locations")}<textarea name="locations" rows={4} defaultValue={watch.locations.join("\n")} /><small>{t("applications.sources.locationsHint")}</small></label></div><label className="applications-check"><input name="remoteOnly" type="checkbox" defaultChecked={watch.remoteOnly} /><span><strong>{t("applications.sources.remoteOnly")}</strong><small>{t("applications.sources.remoteOnlyHint")}</small></span></label><footer><span>{t("applications.sources.lastRun").replace("{date}", lastRun).replace("{count}", String(watch.lastCount))}</span><button className="button primary" type="submit" disabled={pending}>{t("applications.sources.save")}</button></footer>{watch.lastError ? <p className="applications-form-error" role="status">{watch.lastError}</p> : null}</form></section>
      ) : null}

      {message ? <p className="applications-status" role="status">{message}</p> : null}
      {modal ? <ApplicationModal kind={modal} today={today} applications={applications} application={editingApplication} onClose={closeModal} /> : null}
      {documentToDelete ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDocumentToDelete(null)}>
          <div className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="applications-delete-document-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-icon"><Trash2 size={18} aria-hidden /></div>
            <h3 id="applications-delete-document-title">{t("applications.document.deleteTitle")}</h3>
            <p className="muted">{t("applications.document.deleteConfirm").replace("{name}", documentToDelete.name)}</p>
            <div className="modal-actions">
              <button type="button" className="button" autoFocus onClick={() => setDocumentToDelete(null)}>{t("workspace.cancel")}</button>
              <button type="button" className="button danger" disabled={pending} onClick={() => deleteDocument(documentToDelete)}>{t("workspace.delete")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
