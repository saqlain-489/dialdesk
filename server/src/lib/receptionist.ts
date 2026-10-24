import { env } from '../config/env.js'

// `callerName` is who last spoke to them, so the receptionist can say whose assistant it is.
export type LeadContext = { phone: string; businessName: string; website?: string | null; callerName?: string | null }

// Tells the receptionist worker who this workspace has dialed, so the AI can greet a callback
// by business name. Best effort by design: a failure here must never affect a call.
export async function pushLeadContext(
  orgSlug: string,
  leads: LeadContext[],
): Promise<{ ok: boolean; written?: number }> {
  const { receptionistUrl, sharedSecret } = env.inbound
  if (!receptionistUrl || !sharedSecret || leads.length === 0) return { ok: false }
  try {
    const res = await fetch(`${receptionistUrl}/internal/lead-context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sharedSecret}` },
      body: JSON.stringify({ org: orgSlug, leads }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { ok: false }
    const body = (await res.json()) as { written?: number }
    return { ok: true, written: body.written }
  } catch {
    return { ok: false }
  }
}
