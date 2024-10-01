# Production Setup

Provision a Ubuntu server.  Makefile assumes

### Install stuff

* Install [nodejs](https://deb.nodesource.com/)
* Setup a [Cloudflare Tunne](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)

### Configure sources

* Create an AWS bucket + AWS keypair with access to said bucket.
* Create an Audius app in [account settings](https://audius.co/settings).
* `cp sources.example.json data/sources.json` and populate values.

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
npm run start:prod
```

To run as managed process:

```bash
pm2 startup
# copy paste the line as instructed
pm2 save
```

## deploy

```bash
make
```


