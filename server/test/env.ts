import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'

// Imported first by every test file. config/env.ts reads process.env when it is first
// imported, and dotenv never overrides a key that is already set, so these win over
// server/.env, which may point at a hosted database and carry real keys.
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGO_URI: `mongodb://127.0.0.1:27017/dialdesk_test_${process.pid}`,
  JWT_SECRET: 'test-jwt-secret',
  ORG_SECRETS_KEY: randomBytes(32).toString('base64'),
  PUBLIC_URL: 'https://dialdesk.test',
  LEGACY_WEBHOOK_ORG: 'alpha',
  INBOUND_SHARED_SECRET: 'test-inbound-secret',
  RECEPTIONIST_URL: '',
  CALL_TZ: 'America/New_York',
  CALL_WINDOW_START: '0',
  CALL_WINDOW_END: '24',
  CALL_WINDOW_DAYS: '1,2,3,4,5,6,7',
  TRANSCRIBE_ENABLED: 'true',
  TRANSCRIBE_STATES: 'NY',
})

// 10s: sibling imports (twilio, mongoose) can block the event loop past a short timeout; a closed port fails fast.
function mongoReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 27017, timeout: 10_000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

// Every server test needs a throwaway local mongod; without one each suite is skipped with this reason.
export const skipWithoutMongo: string | false = (await mongoReachable())
  ? false
  : 'MongoDB is not running on 127.0.0.1:27017 (start mongod or `docker run -p 27017:27017 mongo:7`)'

if (skipWithoutMongo) console.warn(`[server tests] skipped: ${skipWithoutMongo}`)
