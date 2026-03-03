import http from 'node:http'

const port = Number(process.env.PORT) || 8787

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.statusCode = 404
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: 'not_found' }))
})

server.listen(port, () => {
  console.log(`server listening on http://localhost:${port}`)
})
