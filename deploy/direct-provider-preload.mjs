import { appendFileSync } from 'node:fs';
import { installDirectProviderObserver, providerObservationConfigFromEnv } from './direct-provider-observer.mjs';

// Explicit --import opt-in for disposable API/worker processes. Reporting
// commands such as provider:check install their own observer; do not preload
// those commands. The pure library rejects accidental double installation.
const output = process.env.THREADKEEPER_PROVIDER_OBSERVATIONS_FILE;
if (output) {
  installDirectProviderObserver({
    ...providerObservationConfigFromEnv(),
    onRecord(record) {
      try {
        const line = JSON.stringify(record) + '\n';
        if (output === '-') process.stdout.write(line);
        else appendFileSync(output, line, { mode: 0o600 });
      } catch {
        process.stderr.write('provider_observation_write_failed\n');
        process.exitCode = 1;
      }
    },
  });
}
