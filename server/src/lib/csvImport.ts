import { parse } from 'csv-parse/sync'
import type { Types } from 'mongoose'
import { Lead } from '../models/Lead.js'
import { toE164 } from './phone.js'
import { isSuppressed, suppress } from './suppression.js'

export type ImportResult = {
  batch: string
  totalRows: number
  imported: number
  updated: number
  skippedNoPhone: number
  skippedBadPhone: number
  duplicatesInFile: number
  // A company another workspace owns right now (one owner per company across workspaces).
  skippedOwnedElsewhere: number
  // On the brand-wide do-not-call list, or flagged as such in this file.
  skippedDoNotCall: number
  errors: string[]
}

// Header aliases: the first name in each list is the canonical export format, the rest
// cover hand-made sheets. Matching is case/space/underscore-insensitive.
const FIELD_ALIASES: Record<string, string[]> = {
  businessName: ['business_name', 'name', 'company', 'business', 'company_name'],
  phone: ['phone', 'phone_number', 'telephone', 'tel', 'mobile', 'number'],
  website: ['website', 'url', 'site'],
  bestEmail: ['best_email', 'email', 'email_address'],
  ownerName: ['owner_name', 'owner', 'contact', 'contact_name'],
  ownerLabel: ['owner_label'],
  askForName: ['ask_for', 'ask_for_name'],
  askForRole: ['ask_for_role'],
  askForNote: ['ask_for_note'],
  address: ['address', 'street', 'full_address'],
  category: ['category', 'type', 'industry'],
  rating: ['rating', 'stars'],
  reviewCount: ['review_count', 'reviews', 'num_reviews'],
  siteQualityScore: ['site_quality_score', 'quality_score', 'score'],
  siteIssues: ['site_issues', 'issues'],
  siteYear: ['site_year', 'copyright_year', 'year'],
  sitePlatform: ['site_platform', 'platform', 'cms'],
  hookSnippet: ['hook_snippet', 'hook', 'opener', 'notes'],
  googleMapsUrl: ['google_maps_url', 'maps_url', 'google_url'],
  lane: ['lane', 'segment', 'bucket'],
  city: ['city', 'town'],
  state: ['state', 'province', 'region'],
  doNotCall: ['do_not_contact', 'do_not_call', 'dnc', 'opt_out'],
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s\-.]+/g, '_').replace(/[^a-z0-9_]/g, '')
}

function buildHeaderMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const header of headers) {
    const normalized = normalizeKey(header)
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (map[field]) continue
      if (aliases.includes(normalized)) {
        map[field] = header
        break
      }
    }
  }
  return map
}

function num(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined
  const parsed = Number(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export async function importCsv(buffer: Buffer, batch: string, orgId: Types.ObjectId): Promise<ImportResult> {
  const rows: Record<string, string>[] = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  })

  const result: ImportResult = {
    batch,
    totalRows: rows.length,
    imported: 0,
    updated: 0,
    skippedNoPhone: 0,
    skippedBadPhone: 0,
    duplicatesInFile: 0,
    skippedOwnedElsewhere: 0,
    skippedDoNotCall: 0,
    errors: [],
  }

  if (rows.length === 0) {
    result.errors.push('CSV contained no data rows')
    return result
  }

  const headerMap = buildHeaderMap(Object.keys(rows[0] ?? {}))
  if (!headerMap.phone) {
    result.errors.push(
      `No phone column found. Looked for: ${FIELD_ALIASES.phone?.join(', ')}. ` +
        `Found columns: ${Object.keys(rows[0] ?? {}).join(', ')}`,
    )
    return result
  }

  const pick = (row: Record<string, string>, field: string): string | undefined =>
    headerMap[field] ? row[headerMap[field] as string] : undefined

  const seenInFile = new Set<string>()

  for (const [index, row] of rows.entries()) {
    const rawPhone = pick(row, 'phone')
    if (!rawPhone?.trim()) {
      result.skippedNoPhone++
      continue
    }

    const phone = toE164(rawPhone)
    if (!phone) {
      result.skippedBadPhone++
      if (result.errors.length < 10) {
        result.errors.push(`Row ${index + 2}: unparseable phone "${rawPhone}"`)
      }
      continue
    }

    if (seenInFile.has(phone)) {
      result.duplicatesInFile++
      continue
    }
    seenInFile.add(phone)

    const issuesRaw = pick(row, 'siteIssues')
    const dncRaw = pick(row, 'doNotCall')?.toLowerCase()

    const doc = {
      phone,
      businessName: str(pick(row, 'businessName')) ?? phone,
      website: str(pick(row, 'website')),
      bestEmail: str(pick(row, 'bestEmail')),
      ownerName: str(pick(row, 'ownerName')),
      ownerLabel: str(pick(row, 'ownerLabel')),
      askForName: str(pick(row, 'askForName')),
      askForRole: str(pick(row, 'askForRole')),
      askForNote: str(pick(row, 'askForNote')),
      address: str(pick(row, 'address')),
      category: str(pick(row, 'category')),
      rating: num(pick(row, 'rating')),
      reviewCount: num(pick(row, 'reviewCount')),
      siteQualityScore: num(pick(row, 'siteQualityScore')),
      siteIssues: issuesRaw
        ? issuesRaw.split(';').map((s) => s.trim()).filter(Boolean)
        : [],
      siteYear: num(pick(row, 'siteYear')),
      sitePlatform: str(pick(row, 'sitePlatform')),
      hookSnippet: str(pick(row, 'hookSnippet')),
      googleMapsUrl: str(pick(row, 'googleMapsUrl')),
      lane: str(pick(row, 'lane')),
      city: str(pick(row, 'city')),
      state: str(pick(row, 'state')),
      doNotCall: dncRaw === 'yes' || dncRaw === 'true' || dncRaw === '1',
      batch,
    }

    try {
      const { doNotCall, ...refreshable } = doc
      if (doNotCall) await suppress(phone, { reason: 'flagged in an import', source: 'import', orgId })

      const existing = await Lead.findOne({ orgId, phone, claimed: true })
      if (existing) {
        // Re-importing refreshes lead data but must never reset pipeline progress.
        existing.set(refreshable)
        await existing.save()
        result.updated++
        continue
      }

      if (doNotCall || (await isSuppressed(phone))) {
        result.skippedDoNotCall++
        continue
      }
      // The one deliberate cross-workspace read here: whether someone else owns this company.
      if (await Lead.exists({ phone, claimed: true }).setOptions({ crossTenant: true })) {
        result.skippedOwnedElsewhere++
        continue
      }

      await Lead.create({ ...refreshable, orgId, claimed: true, status: 'new' })
      result.imported++
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        result.skippedOwnedElsewhere++
      } else if (result.errors.length < 10) {
        result.errors.push(`Row ${index + 2}: ${(err as Error).message}`)
      }
    }
  }

  return result
}
