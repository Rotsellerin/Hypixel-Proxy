import http, { IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'

type ControlApiOptions = {
  host: string
  port: number
  getStatus: () => unknown
  setRoute: (routeId: string) => unknown
  setSplitReminderEnabled: (enabled: boolean) => unknown
  shutdown: () => unknown
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(body)
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      body += chunk
      if (body.length > 64 * 1024) {
        reject(new Error('Request body is too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

async function handleApi(req: IncomingMessage, res: ServerResponse, opts: ControlApiOptions, pathname: string) {
  if (req.method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, opts.getStatus())
    return
  }

  if (req.method === 'POST' && pathname === '/api/route') {
    const body = await readJson(req)
    sendJson(res, 200, opts.setRoute(String(body.routeId || body.route || 'direct')))
    return
  }

  if (req.method === 'POST' && pathname === '/api/split-reminder') {
    const body = await readJson(req)
    if (typeof body.enabled === 'boolean') {
      sendJson(res, 200, opts.setSplitReminderEnabled(body.enabled))
      return
    }
    sendJson(res, 400, { error: 'Expected enabled.' })
    return
  }

  if (req.method === 'POST' && pathname === '/api/shutdown') {
    sendJson(res, 200, opts.shutdown())
    return
  }

  sendJson(res, 404, { error: 'Not found' })
}

export function startDashboard(opts: ControlApiOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${opts.host}:${opts.port}`)

    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, opts, url.pathname)
        return
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        sendText(res, 200, 'Hypixel Proxy control API is running. Use the Windows app to control the proxy.')
        return
      }

      sendText(res, 404, 'Not found')
    } catch (error) {
      sendJson(res, 500, { error: String(error) })
    }
  })

  server.listen(opts.port, opts.host)
  return server
}
