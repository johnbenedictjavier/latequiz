// Loads a module by path at test time. Modules that the fix will create
// (for example src/lib/reuploads.ts) do not exist on unfixed code, so a
// static import would fail the whole file. Loading them inside each test
// keeps a missing module scoped to the tests that need it.
//
// Paths are resolved relative to the tests/ directory.

const testsDir = new URL('../', import.meta.url)

export async function loadModule<T>(relativeToTests: string): Promise<T> {
  const url = new URL(relativeToTests, testsDir).href
  return (await import(/* @vite-ignore */ url)) as T
}

export async function tryLoadModule<T>(relativeToTests: string): Promise<T | null> {
  try {
    return await loadModule<T>(relativeToTests)
  } catch {
    return null
  }
}
