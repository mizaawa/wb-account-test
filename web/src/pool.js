export async function runPool(accounts, check, onState = async () => {}, concurrency = 8, signal) {
  let cursor = 0
  const results = new Array(accounts.length)
  async function worker() {
    while (cursor < accounts.length) {
      const index = cursor++
      if (signal?.aborted) { results[index] = { status: 'cancelled' }; await onState(index, 'cancelled', results[index]); continue }
      await onState(index, 'testing')
      try { results[index] = { status: 'success', value: await check(accounts[index], signal) } }
      catch (error) { results[index] = { status: error.kind === 'cancelled' ? 'cancelled' : 'failed', error } }
      await onState(index, results[index].status, results[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, worker))
  return results
}
