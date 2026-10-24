import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express'

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

function forwardRejections(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = handler(req, res, next) as unknown
      if (result instanceof Promise) result.catch(next)
    } catch (err) {
      next(err)
    }
  }
}

// Express 4 ignores a rejected promise from an async handler, and Node then exits on the
// unhandled rejection. Wrapping here turns a failed query (or a tenant-scope violation)
// into a 500 for that one request instead of taking the server down mid-shift.
export function safeRouter(): Router {
  const router = Router()
  for (const method of METHODS) {
    const register = router[method].bind(router) as (path: unknown, ...handlers: RequestHandler[]) => Router
    ;(router as unknown as Record<string, unknown>)[method] = (path: unknown, ...handlers: RequestHandler[]) =>
      register(path, ...handlers.map(forwardRejections))
  }
  return router
}
