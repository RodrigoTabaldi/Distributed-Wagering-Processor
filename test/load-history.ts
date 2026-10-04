// Mesmo experimento e mesmos adapters; só muda o histórico e a latência controlada de publicação.
// Variáveis são passadas diretamente ao processo, sem sintaxe de shell dependente do sistema.
const child = Bun.spawn([process.execPath, 'run', 'test/load.ts'], {
  env: {
    ...process.env,
    LOAD_HISTORY_ENTRIES: process.env.LOAD_HISTORY_ENTRIES ?? '500',
    LOAD_SQS_DELAY_MS: process.env.LOAD_SQS_DELAY_MS ?? '25',
    LOAD_DRAIN_TIMEOUT_MS: process.env.LOAD_DRAIN_TIMEOUT_MS ?? '120000',
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exitCode = await child.exited;
