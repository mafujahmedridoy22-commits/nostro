// A webhook receiver: check the signature against the raw body before
// trusting anything in it, skip events already seen, then answer 2xx.
// A real one would store the event before answering.
import { createServer } from 'node:http'
import { verifyWebhook } from '@nostro-labs/nostro'

const secret = process.env.NOSTRO_WEBHOOK_SECRET
const seen = new Set()

createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    if (!verifyWebhook({ secret, header: req.headers['nostro-signature'], body })) {
      console.log('refused: bad signature')
      res.writeHead(401).end()
      return
    }
    const event = JSON.parse(body)
    if (!seen.has(event.id)) {
      seen.add(event.id)
      console.log(`verified ${event.type} ${event.subjectId}`)
    }
    res.writeHead(204).end()
  })
}).listen(3000, () => console.log('receiver listening on :3000'))
