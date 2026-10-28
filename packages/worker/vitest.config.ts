import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Small limits, so the tests can reach them.
      miniflare: {
        durableObjects: { KEPT_SWEEP: { className: 'KeptSweepShard', useSQLite: true } },
        bindings: {
          ROOM_GUESTS: '3',
          BLOB_MAX_BYTES: '95',
          BLOB_QUOTA_BYTES: '100',
          BLOB_QUOTA_COUNT: '5',
          // Two hours, so the hourly check is sooner than the deadline.
          ROOM_MAX_SECONDS: '7200',
          KEEP_MAX_SECONDS: '120',
        },
      },
    }),
  ],
})
