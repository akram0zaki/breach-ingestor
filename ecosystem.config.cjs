// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'ingest-orchestrator',
    script: 'orchestrator.js',
    interpreter: 'bash',
    interpreter_args: '-c "nice -n 10 ionice -c2 -n7 node orchestrator.js"',
    autorestart: true,
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
