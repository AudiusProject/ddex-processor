module.exports = {
  apps: [
    {
      name: 'ddex',
      script: 'npm',
      args: 'start',
    },
    {
      name: 'tunnel',
      script: 'cloudflared tunnel run ddex-tunnel',
      autorestart: false,
    },
  ],
}
