import { isValidObjectId } from 'mongoose'
import { clearSession, issueSession, loadSession, publicSession, readSession, verifyCredentials } from '../auth.js'
import { safeRouter } from '../lib/safeRouter.js'
import { User } from '../models/User.js'

export const authRouter = safeRouter()

// POST /api/auth/login
authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string }
  if (!username || !password) {
    res.status(400).json({ error: 'username and password required' })
    return
  }

  const userId = await verifyCredentials(username, password)
  if (!userId) {
    res.status(401).json({ error: 'invalid username or password' })
    return
  }

  const session = await loadSession(userId)
  if (!session) {
    res.status(403).json({ error: 'this account has no workspace yet' })
    return
  }

  issueSession(res, { uid: session.user.id, oid: String(session.org.id) })
  res.json(publicSession(session))
})

// POST /api/auth/logout
authRouter.post('/logout', (_req, res) => {
  clearSession(res)
  res.json({ ok: true })
})

// GET /api/auth/me
authRouter.get('/me', async (req, res) => {
  const session = await readSession(req, res)
  if (!session) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  res.json(publicSession(session))
})

// POST /api/auth/switch-org — the client reloads afterwards, so nothing from the previous
// workspace (Twilio device, caches, page state) survives the switch.
authRouter.post('/switch-org', async (req, res) => {
  const current = await readSession(req, res)
  if (!current) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const { orgId } = req.body as { orgId?: string }
  const next = orgId && isValidObjectId(orgId) ? await loadSession(current.user.id, orgId) : null
  if (!next) {
    res.status(403).json({ error: 'no access to that workspace' })
    return
  }
  issueSession(res, { uid: next.user.id, oid: String(next.org.id) })
  await User.updateOne({ _id: next.user.id }, { $set: { lastOrgId: next.org.id } })
  res.json(publicSession(next))
})
