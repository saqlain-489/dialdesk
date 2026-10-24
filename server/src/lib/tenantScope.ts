import { Types, type Aggregate, type MongooseQueryMiddleware, type Query, type Schema } from 'mongoose'

export class TenantScopeError extends Error {
  constructor(model: string, op: string) {
    super(`${model}.${op} ran without an orgId scope`)
    this.name = 'TenantScopeError'
  }
}

const QUERY_OPS: MongooseQueryMiddleware[] = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
]

// Only a real ObjectId at the top level counts: `undefined`, `$in`, `$exists` or an orgId
// buried in an `$or` would each let rows from another workspace through.
const isScoped = (filter: Record<string, unknown> | undefined) => filter?.orgId instanceof Types.ObjectId

/**
 * Fails closed on any read or write of a workspace's data that does not name the workspace.
 * Routes still write `{ orgId: req.org.id, ... }` themselves so the scope is visible in the
 * code; this is the net under them. `.setOptions({ crossTenant: true })` is the deliberate
 * exception for brand-wide work (do-not-call fan-out, ownership checks, migration).
 * $lookup sub-pipelines are out of its reach: they match orgId themselves and tests cover them.
 */
export function tenantScope(schema: Schema): void {
  schema.pre(QUERY_OPS, function (this: Query<unknown, unknown>) {
    const options = this.getOptions() as { crossTenant?: boolean }
    if (options.crossTenant) {
      delete options.crossTenant
      return
    }
    if (!isScoped(this.getFilter())) throw new TenantScopeError(this.model.modelName, (this as unknown as { op?: string }).op ?? 'query')
  })

  schema.pre('estimatedDocumentCount', function (this: Query<unknown, unknown>) {
    throw new TenantScopeError(this.model.modelName, 'estimatedDocumentCount')
  })

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    const first = this.pipeline()[0] as { $match?: Record<string, unknown> } | undefined
    if (!isScoped(first?.$match)) throw new TenantScopeError(this.model().modelName, 'aggregate')
  })

  schema.pre('insertMany', function (next: (err?: Error) => void, docs: unknown) {
    const list = (Array.isArray(docs) ? docs : [docs]) as Array<{ orgId?: unknown }>
    const unscoped = list.some((d) => !(d?.orgId instanceof Types.ObjectId) && typeof d?.orgId !== 'string')
    next(unscoped ? new TenantScopeError('Model', 'insertMany') : undefined)
  })

  schema.pre('bulkWrite', function (next: (err?: Error) => void) {
    next(new TenantScopeError('Model', 'bulkWrite'))
  })
}
