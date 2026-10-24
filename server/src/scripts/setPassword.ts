import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import { connectDb } from '../db.js'
import { User } from '../models/User.js'

// Interactive so the password is typed into a terminal rather than passed as an argv value
// that lands in shell history. A new login can't sign in until it is added to a workspace
// with `npm run org -- add-member`.
async function main(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout })

  await connectDb()

  const existing = await User.find({}, { username: 1, displayName: 1, memberships: 1 }).lean()
  if (existing.length > 0) {
    console.log('\nExisting accounts:')
    for (const u of existing) console.log(`  ${u.username} (${u.displayName}, ${u.memberships.length} workspace(s))`)
  }

  const username = (await rl.question('\nUsername: ')).trim().toLowerCase()
  if (!username) throw new Error('username is required')

  const password = (await rl.question('New password: ')).trim()
  if (password.length < 8) throw new Error('password must be at least 8 characters')
  const passwordHash = await bcrypt.hash(password, 10)

  const user = await User.findOne({ username })
  if (user) {
    await User.updateOne({ _id: user._id }, { $set: { passwordHash } })
    console.log(`\nPassword updated for "${username}".`)
  } else {
    const displayName = (await rl.question('Name they say on calls (e.g. Sam): ')).trim()
    if (!displayName) throw new Error('display name is required')
    await User.create({ username, passwordHash, displayName })
    console.log(`\nCreated "${username}". Add them to a workspace: npm run org -- add-member <slug> ${username} --role caller`)
  }

  rl.close()
  await mongoose.disconnect()
}

main().catch(async (err) => {
  console.error(`\nError: ${(err as Error).message}`)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
