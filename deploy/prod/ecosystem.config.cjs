/**
 * PM2 production config for EC2 (no Docker).
 *
 * Usage on server (from unpacked release directory):
 *   cp deploy/prod/.env.production.example .env   # fill values
 *   npm ci && npm run build
 *   pm2 start deploy/prod/ecosystem.config.cjs --env production
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'swat2-prompt-service',
      cwd: './prompt-service',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 8788,
        SWAT_BASELINE_MODE: 'prompt_changed',
      },
      error_file: '../logs/prompt-service-error.log',
      out_file: '../logs/prompt-service-out.log',
      merge_logs: true,
      time: true,
      autorestart: true,
      max_memory_restart: '512M',
    },
    {
      name: 'swat2',
      cwd: './.next/standalone',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOSTNAME: '0.0.0.0',
        FLOYO_PROMPT_SERVICE_URL: 'http://127.0.0.1:8788/generate-prompt',
      },
      error_file: '../../logs/swat2-error.log',
      out_file: '../../logs/swat2-out.log',
      merge_logs: true,
      time: true,
      autorestart: true,
      max_memory_restart: '1G',
      wait_ready: false,
      listen_timeout: 10000,
    },
  ],
};
