module.exports = {
  apps: [
    {
      name: 'ddex',
      script: 'npm',
      args: 'start',
    },
    {
      name: 'worker',
      script: 'npm',
      args: 'run worker',
    },
    {
      name: 'tunnel',
      script: 'cloudflared tunnel run',
      autorestart: false,
    },
  ],
}
