
module.exports = {
  apps: [{
    name: 'breach-ingestor',
    script: 'ingest-fs.js',
    interpreter: 'node',
    // interpreter_args: '-c "nice -n 10 ionice -c2 -n7 node orchestrator.js"',
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,
    // Stop autorestart on graceful shutdown (exit code 0)
    stop_exit_codes: [0]
  }, {
    name: 'breach-ingestor-pg',
    // script: 'ingest-pg.js',
    // interpreter: 'node',
    // interpreter_args: '--max-old-space-size=1536',
    script: 'nice -n 10 ionice -c2 -n7 node --max-old-space-size=1536 ingest-pg.js',
    interpreter: 'bash',
    interpreter_args: '-c',
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,
    // Stop autorestart on graceful shutdown (exit code 0)
    stop_exit_codes: [0],
    env: {
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: '8'
    }
  }]
};
