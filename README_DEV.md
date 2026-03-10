# DEV

Install + run tests:

```bash
docker compose up -d

npm i
make test
```

Create `.env` file like:

```
COOKIE_SECRET='abc'
NODE_ENV = 'staging'
DDEX_URL = 'https://localhost:8989'
DDEX_API_KEY='your-staging-oauth-app-key'   # Create an app at staging.audius.co/settings for the ddex tool
ADMIN_HANDLES = 'user1,user2'
SKIP_SDK_PUBLISH='true'
DB_URL='postgresql://postgres:example@127.0.0.1:40111/postgres'
DISCOVERY_DB=
```

Create `data/sources.json` file like:

> For **login** OAuth you need `DDEX_API_KEY` from a [ddex app on staging](https://staging.audius.co/settings).
> Source `ddexKey`/`ddexSecret` in sources.json are for publishing/distribution, not for the web UI login.

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

**Source admins:** Super admins can add Audius handles as admins of a given source via `/admin`. Those users will see a filtered view (Releases + Users for their source) on next login.

**`autoPublish`:** Set `"autoPublish": true` on a source to have the worker automatically publish releases. For each release without an assigned user, it will match an existing authorized user by artist name, or create a claimable account if none exists. Requires hedgehog/identity to be configured for claimable account creation.

Parse + print a local file:

```bash
npx tsx cli.ts parse sourceA fixtures/01_delivery.xml
```

Run server:

```bash
npm run dev
```

- Visit http://localhost:8989/
- do oauth
- visit http://localhost:8989/releases - see two releases from initial CLI run above

If you have setup an S3 source in `data/sources.json`, you can run the worker to crawl buckets and see results locally:

```bash
npm run worker
```

If you want to delete the state and re-crawl from the start

```bash
make reset-database
```

---

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
