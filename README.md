# Audius DDEX Processor

A node.js program + webapp to ingest DDEX files and publish them to Audius.


You configure multiple sources (in `data/sources.json`) and point them to S3 buckets.
The crawler will look for new XML files in the S3 buckets, parse the details and publish the music if preconditions are met.

Tracks are either
1. Published automatically to an artist profile that authorizes the source keypair to distribute on their behalf. This is done using the [Audius SDK oauth method](https://docs.audius.org/developers/sdk/oauth).
2. Published manually using the UI tools provided in this package


* See [README_DEV](./README_DEV.md) for dev setup.
* See [README_PROD](./README_PROD.md) for prod setup.
