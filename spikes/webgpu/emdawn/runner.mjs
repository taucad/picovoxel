const variant = new URL(globalThis.location.href).searchParams.get('variant') ?? 'callback';
const output = document.querySelector('pre');

try {
  const module = await import(`./dist/${variant}.mjs`);
  await module.default();
  await new Promise((resolve, reject) => {
    const deadline = performance.now() + 120_000;
    const poll = () => {
      if (globalThis.__emdawnDone === true) {
        resolve();
        return;
      }
      if (performance.now() > deadline) {
        reject(new Error(`${variant} timed out`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
  globalThis.__done = true;
  globalThis.__result = { ...globalThis.__emdawnResult, variant };
  output.textContent = JSON.stringify(globalThis.__result, null, 2);
} catch (error) {
  globalThis.__done = true;
  globalThis.__error = error instanceof Error ? error.message : String(error);
  output.textContent = globalThis.__error;
}
