import multer from 'multer'
import { requireOwner } from '../auth.js'
import { importCsv } from '../lib/csvImport.js'
import { safeRouter } from '../lib/safeRouter.js'

export const importRouter = safeRouter()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
})

// POST /api/import/csv  (owner only — importing changes what the caller can dial)
// Rows land in the workspace the owner has open.
importRouter.post('/csv', requireOwner, upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded (expected multipart field "file")' })
    return
  }

  const batch =
    (req.body?.batch as string | undefined)?.trim() ||
    req.file.originalname.replace(/\.csv$/i, '')

  try {
    const result = await importCsv(req.file.buffer, batch, req.org!.id)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: `could not parse CSV: ${(err as Error).message}` })
  }
})
