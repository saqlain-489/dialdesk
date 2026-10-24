import mongoose from 'mongoose'
import { env } from './config/env.js'

const DEFAULT_DB_NAME = 'dialdesk'

// An SRV URI copied out of the Atlas dashboard has no database in its path
// ("...mongodb.net/?appName=X"), and Mongo silently falls back to a database called
// `test`. On a cluster shared with another project that means writing into someone
// else's collections — which surfaces as a baffling duplicate-key error on an index
// this app never created, not as a connection problem. Pinning the name explicitly
// removes the whole failure mode.
function databaseNameIn(uri: string): string | null {
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '')
  const path = withoutScheme.slice(withoutScheme.indexOf('/') + 1)
  if (!withoutScheme.includes('/')) return null
  const name = path.split('?')[0]
  return name ? name : null
}

// `buildSchema` lets Mongoose create collections and indexes on connect. Only the local dev
// server and tests opt in. Production indexes are built by the migration script in a known
// order (the phone-ownership swap), and a CLI run from a laptop against prod — even a dry
// run — must not create anything as a side effect of connecting.
export async function connectDb({ buildSchema = false }: { buildSchema?: boolean } = {}): Promise<void> {
  mongoose.set('strictQuery', true)

  const named = databaseNameIn(env.mongoUri)
  if (!named) {
    console.warn(
      `[db] MONGO_URI has no database in its path — using "${DEFAULT_DB_NAME}". ` +
        `Add /${DEFAULT_DB_NAME} before the "?" to make this explicit.`,
    )
  }

  await mongoose.connect(env.mongoUri, {
    dbName: named ?? DEFAULT_DB_NAME,
    autoIndex: buildSchema,
    autoCreate: buildSchema,
  })

  const safeUri = env.mongoUri.replace(/\/\/[^@]*@/, '//***@')
  console.log(`[db] connected to ${safeUri} (database: ${named ?? DEFAULT_DB_NAME})`)
}
