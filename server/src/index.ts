import { createApp } from './app.js'
import { connectDb } from './db.js'
import { env } from './config/env.js'
import { checkCallWindow } from './lib/callWindow.js'
import { repairPendingRecycles } from './lib/recycle.js'
import { assertSecretsKey } from './lib/secrets.js'
import { Organization } from './models/Organization.js'

async function main(): Promise<void> {
  // Fail at boot, not on the first dial: without it no workspace's Twilio keys can be read.
  assertSecretsKey()
  await connectDb({ buildSchema: !env.isProduction })
  const workspaces = await Organization.countDocuments({ status: 'active' })
  // A recycle interrupted by a crash leaves its phone owned by nobody until finished.
  const repaired = await repairPendingRecycles()
  if (repaired) console.log(`[server] finished ${repaired} interrupted recycle(s)`)

  const app = createApp()
  app.listen(env.port, () => {
    const window = checkCallWindow()
    console.log(`[server] listening on :${env.port}`)
    console.log(`[server] public url  ${env.publicUrl}`)
    console.log(`[server] workspaces  ${workspaces} active${workspaces ? '' : ' (create one: npm run org -- create)'}`)
    console.log(`[server] call window ${window.open ? 'OPEN' : 'CLOSED'} — ${window.reason}`)
  })
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
