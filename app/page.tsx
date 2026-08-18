/**
 * Home — the IGRIS Commander Home operating surface (UX Foundation U6).
 *
 * A server shell that computes the read-only `HomeSnapshot` once for first paint
 * and hands it to the client `HomeDashboard` (which then polls GET /api/home).
 * Home is now a briefing + Commander entry + operational summary — NOT the old
 * business-analytics dashboard (those views live on their own pages: /social,
 * /integrations, /comms, /brain, /roadmap, /agents). No new source of truth.
 */
import { getDb } from '@/lib/data';
import { buildHomeSnapshot } from '@/lib/home/service';
import { greetingForHour } from '@/lib/home/model';
import { HomeDashboard } from '@/components/HomeDashboard';

export const dynamic = 'force-dynamic';

/** Configurable operator name (OPERATOR_NAME in .env.local); never a demo name. */
function operatorName(): string {
  return process.env.OPERATOR_NAME?.trim() || 'Operator';
}

export default function HomePage() {
  const db = getDb();
  const snapshot = buildHomeSnapshot(db);
  // Server greeting from server time — the client re-derives it from LOCAL time
  // after mount (hydration-safe: SSR and first client render use this same value).
  const serverGreeting = greetingForHour(new Date().getHours());

  return <HomeDashboard initial={snapshot} operatorName={operatorName()} serverGreeting={serverGreeting} />;
}
