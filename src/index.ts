import { loadConfig } from './config/config.js';
import { createProactiveChatPlugin } from './builtins/proactive-chat/index.js';
import { HermesRuntime } from './core/runtime.js';
import { OpenAICompatibleProvider } from './llm/openai-compatible.js';

/**
 * Kernel entry point.
 *
 * Boots configuration, wires the LLM provider and built-in plugins, starts the
 * runtime, and installs a graceful shutdown handler.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const llm = new OpenAICompatibleProvider({
    baseURL: config.llm.baseURL,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    requestTimeoutMs: config.llm.requestTimeoutMs,
  });

  const runtime = new HermesRuntime({ config, llm });
  runtime.register(createProactiveChatPlugin());

  await runtime.start();
  console.log('hermes-kairos runtime started');

  // Keep the process alive until a shutdown signal arrives. Scheduled plugin
  // tasks use unref'd timers, so the kernel owns liveness explicitly.
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`hermes-kairos received ${signal}, shutting down…`);
    clearInterval(keepAlive);
    try {
      await runtime.stop();
    } catch (error) {
      console.error('hermes-kairos shutdown error:', error);
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', (signal) => {
    void shutdown(signal);
  });
  process.on('SIGTERM', (signal) => {
    void shutdown(signal);
  });
}

main().catch((error: unknown) => {
  console.error('hermes-kairos failed to start:', error);
  process.exitCode = 1;
});
