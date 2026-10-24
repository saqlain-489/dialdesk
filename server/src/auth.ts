import type { NextFunction, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Types, isValidObjectId } from 'mongoose'
import { env } from './config/env.js'
import { Organization } from './models/Organization.js'
import { User, type OrgRole } from './models/User.js'

const COOKIE_NAME = 'dd_session'
const SESSION_HOURS = 12

export type SessionUser = { id: string; username: string; displayName: string }

// The workspace this request acts in. Every tenant query is scoped by `id`.
export type ActiveOrg = {
  id: Types.ObjectId
  slug: string
  name: string
  role: OrgRole
  companyName: string
  callerId: string | null
}

export type OrgSummary = { id: string; name: string; role: OrgRole }

export type Session = { user: SessionUser; org: ActiveOrg; orgs: OrgSummary[] }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser
      org?: ActiveOrg
    }
  }
}

// Only who and where: the role is looked up per request, so removing a membership or
// demoting someone takes effect on their next click rather than when the cookie expires.
type Claims = { uid: string; oid: string }

export function issueSession(res: Response, claims: Claims): void {
  const token = jwt.sign(claims, env.jwtSecret, { expiresIn: `${SESSION_HOURS}h` })
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  })
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME)
}

// Cookies issued before workspaces carry `id` and no `oid`; they are still honoured.
function readClaims(req: Request): { uid: string; oid?: string } | null {
  const raw = req.cookies?.[COOKIE_NAME]
  if (!raw) return null
  try {
    const payload = jwt.verify(raw, env.jwtSecret) as jwt.JwtPayload & { uid?: string; id?: string; oid?: string }
    const uid = payload.uid ?? payload.id
    if (!uid || !isValidObjectId(uid)) return null
    return { uid, oid: payload.oid && isValidObjectId(payload.oid) ? payload.oid : undefined }
  } catch {
    return null
  }
}

type LoadedUser = {
  _id: Types.ObjectId
  username: string
  displayName: string
  memberships: { orgId: Types.ObjectId; role: OrgRole }[]
  lastOrgId?: Types.ObjectId
}

type OrgRow = {
  _id: Types.ObjectId
  slug: string
  name: string
  brand?: { companyName?: string }
  twilio?: { callerId?: string }
}

/**
 * Resolves the user and the workspace they act in. `wantedOrg` absent means "pick one":
 * the last workspace used if still a member, else the first. A wanted workspace the user is
 * not an active member of resolves to null, the same as one that does not exist.
 */
export async function loadSession(userId: string, wantedOrg?: string): Promise<Session | null> {
  const user = await User.findById(userId, { username: 1, displayName: 1, memberships: 1, lastOrgId: 1 }).lean<LoadedUser>()
  if (!user) return null

  const orgs = await Organization.find(
    { _id: { $in: user.memberships.map((m) => m.orgId) }, status: 'active' },
    { slug: 1, name: 1, 'brand.companyName': 1, 'twilio.callerId': 1 },
  )
    .sort({ name: 1 })
    .lean<OrgRow[]>()
  const roleOf = (orgId: Types.ObjectId) => user.memberships.find((m) => m.orgId.equals(orgId))?.role

  const pick = wantedOrg
    ? orgs.find((o) => o._id.equals(wantedOrg))
    : (orgs.find((o) => user.lastOrgId && o._id.equals(user.lastOrgId)) ?? orgs[0])
  const role = pick && roleOf(pick._id)
  if (!pick || !role) return null

  return {
    user: { id: String(user._id), username: user.username, displayName: user.displayName },
    org: {
      id: pick._id,
      slug: pick.slug,
      name: pick.name,
      role,
      companyName: pick.brand?.companyName ?? '',
      callerId: pick.twilio?.callerId ?? null,
    },
    orgs: orgs.map((o) => ({ id: String(o._id), name: o.name, role: roleOf(o._id)! })),
  }
}

export async function readSession(req: Request, res: Response): Promise<Session | null> {
  const claims = readClaims(req)
  if (!claims) return null
  const session = await loadSession(claims.uid, claims.oid)
  // A pre-workspace cookie is upgraded in place: a 401 mid-shift would break the Twilio
  // token refresh and the transcript uploads that are still queued in the browser.
  if (session && !claims.oid) issueSession(res, { uid: session.user.id, oid: String(session.org.id) })
  return session
}

export function publicSession(session: Session) {
  const { org } = session
  return {
    user: session.user,
    org: { id: String(org.id), name: org.name, role: org.role, companyName: org.companyName },
    orgs: session.orgs,
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await readSession(req, res)
    if (!session) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    // The cookie is shared by every tab. A tab still showing workspace A after another tab
    // switched to B must not write into B (an import, a disposition, a token refresh).
    const sent = req.get('x-org')
    if (sent && sent !== String(session.org.id)) {
      res.status(409).json({ error: 'org_changed', detail: 'This tab is on another workspace. Reload the page.' })
      return
    }
    req.user = session.user
    req.org = session.org
    next()
  } catch (err) {
    next(err)
  }
}

export function requireRole(role: OrgRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.org?.role !== role) {
      res.status(403).json({ error: `${role} only` })
      return
    }
    next()
  }
}

export const requireOwner = requireRole('owner')

export async function verifyCredentials(username: string, password: string): Promise<string | null> {
  const user = await User.findOne({ username: username.toLowerCase().trim() }, { passwordHash: 1 })
  if (!user) return null
  const ok = await bcrypt.compare(password, user.passwordHash)
  return ok ? String(user._id) : null
}
