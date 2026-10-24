import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cookieParser from 'cookie-parser'
import { env } from './config/env.js'
import { requireAuth } from './auth.js'
import { authRouter } from './routes/auth.js'
import { leadsRouter } from './routes/leads.js'
import { importRouter } from './routes/importRoutes.js'
import { statsRouter } from './routes/stats.js'
import { transcriptsRouter } from './routes/transcripts.js'
import { callsRouter } from './routes/calls.js'
import { tokenRouter } from './routes/token.js'
import { twilioWebhookRouter } from './twilio/webhooks.js'
import { inboundRouter } from './routes/inbound.js'
import { orgRouter } from './routes/org.js'
import { checkCallWindow } from './lib/callWindow.js'
import { TenantScopeError } from './lib/tenantScope.js'

export function createApp(): express.Express {
  const app = express()

  // Hosting platforms terminate TLS upstream. Without this, req.protocol is 'http'
  // and secure cookies never get set.
  app.set('trust proxy', true)

  // ORDER IS LOAD-BEARING. Twilio posts application/x-www-form-urlencoded, and
  // twilio.webhook() validates the signature over req.body. Mount only express.json()
  // and req.body is {} — the signature is then computed over zero params and every
  // webhook 403s while looking completely healthy. This parser must come first.
  app.use('/api/twilio', express.urlencoded({ extended: false }))
  app.use('/api/twilio', twilioWebhookRouter)

  // Bearer-authenticated by the receptionist worker's shared secret, not a session.
  // Mounted before the global parser so its tighter body limit is the one that applies.
  app.use('/api/inbound', express.json({ limit: '64kb' }), inboundRouter)

  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  app.get('/api/health', (_req, res) => {
    // Infra only. Each workspace's Twilio state and exact Voice URL are on /api/org/setup.
    res.json({
      ok: true,
      // Echoed back because Twilio signs webhooks against this exact origin, and a
      // mismatch 403s every call while the app looks perfectly healthy. It is a public
      // URL, so exposing it reveals nothing.
      publicUrl: env.publicUrl,
      callWindow: checkCallWindow(),
    })
  })

  app.use('/api/auth', authRouter)

  // Everything below requires a session. The app is on the public internet and can
  // place billable calls, so there is no unauthenticated surface beyond health,
  // login, the signature-validated Twilio webhooks, and the bearer-checked ingest above.
  app.use('/api/org', requireAuth, orgRouter)
  app.use('/api/twilio-token', requireAuth, tokenRouter)
  app.use('/api/leads', requireAuth, leadsRouter)
  app.use('/api/calls', requireAuth, callsRouter)
  app.use('/api/import', requireAuth, importRouter)
  app.use('/api/stats', requireAuth, statsRouter)
  app.use('/api/transcripts', requireAuth, transcriptsRouter)

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'unknown endpoint' })
  })

  // In production the server also serves the built client, so there is one
  // service, one domain, and one webhook URL to configure.
  const clientDist = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../client/dist')
  app.use(express.static(clientDist))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      if (err) res.status(404).send('Client not built. Run `npm run build` in client/.')
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[error]', err)
    // A scope violation is a bug in our code, and its message names models and operations.
    const message = err instanceof TenantScopeError ? 'internal error' : err.message
    res.status(500).json({ error: message || 'internal error' })
  })

  return app
}

export { env }
