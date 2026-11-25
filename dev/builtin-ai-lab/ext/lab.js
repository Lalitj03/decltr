// Same job as ../lab.html, but running in an extension page, where sampling parameters are available.
const OPTS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

window.__lab = {
  exists: () => typeof LanguageModel !== 'undefined',
  availability: () => LanguageModel.availability(OPTS),
  params: () => LanguageModel.params(),
  async run({ system, user, schema, sampling, timeoutMs = 90000 }) {
    const t0 = performance.now();
    let session;
    try {
      session = await LanguageModel.create({ ...OPTS, ...(sampling ?? {}), initialPrompts: [{ role: 'system', content: system }] });
    } catch (e) {
      return { ok: false, error: `${e.name}: ${e.message}`, stage: 'create' };
    }
    const createMs = performance.now() - t0;
    try {
      const t1 = performance.now();
      const output = await session.prompt(user, { responseConstraint: schema, signal: AbortSignal.timeout(timeoutMs) });
      return { ok: true, output, createMs, promptMs: performance.now() - t1, applied: { temperature: session.temperature, topK: session.topK } };
    } catch (e) {
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      return { ok: false, timedOut, error: timedOut ? `Timed out after ${timeoutMs / 1000}s (still generating)` : `${e.name}: ${e.message}`, stage: 'prompt', createMs };
    } finally {
      session.destroy();
    }
  },
};
