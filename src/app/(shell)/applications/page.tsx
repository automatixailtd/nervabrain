import { notFound } from "next/navigation";
import "./applications.css";
import { ApplicationsWorkspace } from "@/components/ApplicationsWorkspace";
import { todayISO } from "@/lib/dates";
import { listApplicationRecords, noteForClient, readJobWatchSettings, readSetupState } from "@/lib/vault";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  const [records, watch, setup] = await Promise.all([
    listApplicationRecords(),
    readJobWatchSettings(),
    readSetupState(),
  ]);
  if (!setup.modules.applications) notFound();
  return <ApplicationsWorkspace records={records.map(noteForClient)} watch={watch} today={todayISO()} />;
}
