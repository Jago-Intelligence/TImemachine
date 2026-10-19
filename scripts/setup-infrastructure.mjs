import process from 'node:process';
import console from 'node:console';
import { fileURLToPath, URL } from 'node:url';
import { initializeInfrastructure } from './infrastructure-setup.mjs';
try {
  if (process.argv.length > 2) throw new Error('Usage: pnpm workspace:setup');
  const result = initializeInfrastructure(fileURLToPath(new URL('../', import.meta.url)));
  console.log(
    result.generated.length
      ? `Self-hosted settings prepared privately (${result.generated.length} missing fields generated).`
      : 'Self-hosted settings already exist; credentials were preserved.',
  );
  console.log('Use pnpm workspace:password to view your dashboard password locally.');
  console.log(
    'Next: pnpm db:up, pnpm db:migrate, then start the collector and dashboard.',
  );
  console.log(
    'Configure notification providers in Dashboard → Notifications. Back up private .env with the database; keep the encryption key unchanged.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Infrastructure setup failed.');
  process.exitCode = 1;
}
