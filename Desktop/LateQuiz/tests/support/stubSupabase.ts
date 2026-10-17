// Minimal recording stub for the Supabase JS client used by src/lib/*.
// Tests replace `src/lib/supabase` with this client via vi.mock, configure
// per-table / per-RPC / per-storage responses, and inspect the recorded calls.
// It records real calls made by the code under test; it does not fake the
// logic being tested.

export type Result = { data: unknown; error: unknown }

export type QueryOp = { method: string; args: unknown[] }

export type QueryLog = { table: string; ops: QueryOp[] }

export type StubCall =
  | { kind: 'from'; table: string; ops: QueryOp[] }
  | { kind: 'rpc'; name: string; args: unknown }
  | { kind: 'storage'; bucket: string; method: string; args: unknown[] }

type TableHandler = (log: QueryLog) => Result | undefined
type RpcHandler = (args: unknown) => Result
type StorageHandler = (method: string, args: unknown[]) => Result | undefined

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])

export function isWrite(log: { ops: QueryOp[] }) {
  return log.ops.some((op) => WRITE_METHODS.has(op.method))
}

export function opArgs(log: { ops: QueryOp[] }, method: string) {
  return log.ops.find((op) => op.method === method)?.args
}

function defaultTableResult(log: QueryLog): Result {
  const last = log.ops[log.ops.length - 1]?.method
  if (last === 'single' || last === 'maybeSingle') {
    return { data: { id: crypto.randomUUID() }, error: null }
  }
  return { data: [], error: null }
}

export function createStubClient() {
  const calls: StubCall[] = []
  let tableHandlers: Record<string, TableHandler> = {}
  let rpcHandlers: Record<string, RpcHandler> = {}
  let storageHandler: StorageHandler = () => undefined

  function query(table: string) {
    const log: QueryLog = { table, ops: [] }
    calls.push({ kind: 'from', table, ops: log.ops })
    const resolve = (): Result => tableHandlers[table]?.(log) ?? defaultTableResult(log)
    const builder: Record<string | symbol, unknown> = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') {
          return (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve().then(resolve).then(onFulfilled, onRejected)
        }
        return (...args: unknown[]) => {
          log.ops.push({ method: String(prop), args })
          return builder
        }
      },
    })
    return builder
  }

  function storageBucket(bucket: string) {
    const call = (method: string) => async (...args: unknown[]) => {
      calls.push({ kind: 'storage', bucket, method, args })
      const handled = storageHandler(method, args)
      if (handled) return handled
      if (method === 'upload') return { data: { path: args[0] }, error: null }
      if (method === 'createSignedUrl') return { data: { signedUrl: `https://signed.example/${String(args[0])}` }, error: null }
      if (method === 'list') return { data: [], error: null }
      return { data: null, error: null }
    }
    return {
      upload: call('upload'),
      remove: call('remove'),
      list: call('list'),
      createSignedUrl: call('createSignedUrl'),
      download: call('download'),
    }
  }

  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-000000000001' } }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
    from: (table: string) => query(table),
    rpc: (name: string, args?: unknown) => {
      calls.push({ kind: 'rpc', name, args })
      const handler = rpcHandlers[name]
      return Promise.resolve(handler ? handler(args) : { data: [], error: null })
    },
    storage: { from: (bucket: string) => storageBucket(bucket) },
    functions: { invoke: async () => ({ data: null, error: null }) },
  }

  return {
    client,
    calls,
    reset() {
      calls.length = 0
      tableHandlers = {}
      rpcHandlers = {}
      storageHandler = () => undefined
    },
    onTable(table: string, handler: TableHandler) {
      tableHandlers[table] = handler
    },
    onRpc(name: string, handler: RpcHandler) {
      rpcHandlers[name] = handler
    },
    onStorage(handler: StorageHandler) {
      storageHandler = handler
    },
  }
}

export const stub = createStubClient()
