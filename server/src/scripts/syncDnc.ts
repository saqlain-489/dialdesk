import mongoose from 'mongoose'
import { connectDb } from '../db.js'
import { Suppression } from '../models/Suppression.js'
import { toE164 } from '../lib/phone.js'
import { suppressMany } from '../lib/suppression.js'

// Another tool (an email sender, the lead source) records opt-outs as `do_not_contact`
// in its own MongoDB database. Without this sync, someone who replied "stop emailing me"
// still shows up in the call queue, which is the worst complaint you can generate.
// Run it before every shift.
//
//   SOURCE_MONGO_URI=mongodb://127.0.0.1:27017/leads npm run sync:dnc
//
// The source stores phones display-formatted ("(212) 555-0143"), so both sides go
// through toE164 before matching. Opt-outs land on the brand-wide suppression list, so
// they also block leads imported later and every workspace's copy of the lead.

const sourceUri = process.env.SOURCE_MONGO_URI || 'mongodb://127.0.0.1:27017/leads'

async function main() {
  await connectDb()
  const source = await mongoose.createConnection(sourceUri).asPromise()

  const flagged = await source
    .collection('leads')
    .find({ do_not_contact: true }, { projection: { phone: 1 } })
    .toArray()

  const phones = [
    ...new Set(flagged.map((doc) => toE164(String(doc.phone ?? ''))).filter((p): p is string => Boolean(p))),
  ]

  console.log(`source: ${flagged.length} do_not_contact leads, ${phones.length} with a valid phone`)

  const added = await suppressMany(phones, { reason: 'opted out of email', source: 'email-optout' })
  console.log(`dialer: ${added} newly suppressed`)
  console.log(`dialer: ${await Suppression.countDocuments()} numbers on the do-not-call list`)

  await source.close()
  await mongoose.disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
