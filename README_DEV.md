# DEV

Install + run tests:

```bash
npm i
npm test
```

Create `.env` file like:

```
NODE_ENV = 'staging'
DDEX_URL = 'https://localhost:8989'
ADMIN_HANDLES = 'user1,user2'
SKIP_SDK_PUBLISH='true'
```

Create `data/sources.json` file like:

> For oauth to work you'll need to create a [sdk app on staging](https://staging.audius.co/settings)

```
{
  "sources": [
    {
      "env": "staging",
      "name": "sourceA",
      "ddexKey": "",
      "ddexSecret": ""
    }
  ]
}
```

Parse + print a local file:

```bash
npx tsx cli.ts parse sourceA fixtures/01_delivery.xml
```

Run server:

```bash
npm run dev
```

* Visit http://localhost:8989/
* do oauth
* visit http://localhost:8989/releases - see two releases from initial CLI run above


If you have setup an S3 source in `data/sources.json`... you can run worker to crawl buckets and see results locally:

```bash
npx tsx cli worker
```

---

## Other Stuff

> this trys to similate different scenarios... this may be outdated or inaccurate.

### simulate rematch

```bash
sqlite3 data/dev.db "insert into users (id, handle, name) values ('2fuga', '2FUGA', '2FUGA') on conflict do nothing; insert into users (id, handle, name) values ('FUGARIAN', 'FUGARIAN', 'FUGARIAN') on conflict do nothing;"
```

* visit http://localhost:8989/releases
* click rematch
* confirm releases ready to publish

### simulate publish

> This will skip actual SDK writes if you set `SKIP_SDK_PUBLISH='true'` in `.env`

```bash
npx tsx cli.ts publish
```


### nuke db

```bash
# reset sqlite state
rm data/dev.db*
```

### set up local s3 cli
```bash
aws configure --profile local
# enter these details
# AWS Access Key ID [None]: test
# AWS Secret Access Key [None]: test
# Default region name [None]: us-west-2
# Default output format [None]: json
```

edit `~/.aws/config` and add
```
[profile local]
endpoint_url = http://ingress:4566
```

Pull remote s3 into local s3
```bash
audius-compose up ddex-s3

npx tsx cli.ts sync-s3 s3://ddex-prod-raw/20240305090456555

aws s3 ls s3://ddex-prod-raw/20240305090456555 --profile local
```
