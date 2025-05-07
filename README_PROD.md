# Production Setup

Provision a Ubuntu server. Makefile assumes

### Install stuff

- Install [nodejs](https://deb.nodesource.com/)
- Setup a [Cloudflare Tunne](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
- Install [docker](https://docs.docker.com/engine/install/ubuntu/)

### Configure tunnel

looks something like:

```bash
cloudflared tunnel create ddex-staging
cloudflared tunnel route dns ddex-staging ddex.staging.audius.co
```

or

```bash
cloudflared tunnel create ddex-production
cloudflared tunnel route dns ddex-production ddex.audius.co
```

Using UUID, create `~/.cloudflared/config.yml`:

```
url: http://localhost:8989
tunnel: ddex-production
```

If the route setup fails, run `cloudflared tunnel list`, get the UUID and go to [Cloudflare DNS](https://dash.cloudflare.com/3811365464a8e56b2b27a5590e328e49/audius.co/dns/records?recordsSearchSearch=ddex), create a CNAME record and point it at `_uuid_.cfargotunnel.com`

### Configure sources

- Create an AWS bucket + AWS keypair with access to said bucket.
- Create an Audius app in [account settings](https://audius.co/settings).
- `cp sources.example.json data/sources.json` and populate values.

### Configure env

Create a `.env` file like:

```bash
NODE_ENV='production'
DDEX_URL='https://ddex.example.com'
ADMIN_HANDLES='user1,user2'
SKIP_SDK_PUBLISH='true'
```

### Run server and worker

To run in foreground:

```bash
npm run start
```

To run as managed process:

```bash
pm2 startup
# copy paste the line as instructed
pm2 save
```

Any time you change `ecosystem.config.js` you should stop + delete old entries and run `pm2 save` to re-save the startup config.

## deploy

```bash
make
```
