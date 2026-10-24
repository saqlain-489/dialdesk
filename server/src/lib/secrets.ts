import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../config/env.js'

export type Sealed = { v: number; iv: string; tag: string; data: string }

const VERSION = 1

function key(): Buffer {
  const raw = Buffer.from(env.orgSecretsKey, 'base64')
  if (raw.length !== 32) {
    throw new Error('ORG_SECRETS_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)')
  }
  return raw
}

export function assertSecretsKey(): void {
  key()
}

// `context` is bound in as additional data, so a sealed value copied onto another
// workspace or field fails to open instead of silently becoming that one's secret.
export function seal(plain: string, context: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(context))
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    v: VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

export function unseal(sealed: Sealed, context: string): string {
  if (sealed.v !== VERSION) throw new Error(`unsupported sealed secret version ${sealed.v}`)
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(sealed.iv, 'base64'))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
}
