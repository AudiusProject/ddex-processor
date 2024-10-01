# Audius DDEX Processor

This is a node.js program + webapp to ingest DDEX files and publish them to Audius.
You configure multiple sources (in `data/sources.json`) and point them to S3 buckets.
The crawler will look for new XML files in the S3 buckets, parse the details and publish the music if preconditions are met.
To publish to Audius currently, it requires the artist account authorizes the source keypair to publish on their behalf.
This is done using the [Audius SDK oauth method](https://docs.audius.org/developers/sdk/oauth).

* See [README_DEV](./README_DEV.md) for dev setup.
* See [README_PROD](./README_PROD.md) for prod setup.
