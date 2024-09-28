module.exports = {
  apps: [
    {
      name: 'ddex',
      script: 'npm',
      args: 'run start:prod',
    },
    {
      name: 'tunnel',
      script: 'cloudflared tunnel run ddex-tunnel',
      autorestart: false,
    },
  ],
}
