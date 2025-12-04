# Audius DDEX Processor

A node.js program + webapp to ingest DDEX files and publish them to Audius.


You configure multiple sources (in `data/sources.json`) and point them to S3 buckets.
The crawler will look for new XML files in the S3 buckets, parse the details and publish the music if preconditions are met.

Tracks are either
1. Published automatically to an artist profile that authorizes the source keypair to distribute on their behalf. This is done using the [Audius SDK oauth method](https://docs.audius.org/developers/sdk/oauth).
2. Published manually using the UI tools provided in this package

* See [README_DEV](./README_DEV.md) for dev setup.

## Docker

This application can be run as a Docker container. The container runs both the server (`ddex`) and worker processes using PM2.

### Building and Pushing Docker Image

```bash
# Build and optionally push the image
./build-and-push.sh [version]

# Examples:
./build-and-push.sh           # Builds with 'latest' tag
./build-and-push.sh v1.0.0    # Builds with version tag
```

The script will:
- Build the Docker image with the tag `audius/ddex:latest` (and version tag if provided)
- Optionally push to Docker Hub after building

### Running the Docker Image

1. Create a `.env` file like:

```bash
COOKIE_SECRET='openssl rand -hex 16'
NODE_ENV='production'
DDEX_URL='https://ddex.example.com'
ADMIN_HANDLES='user1,user2'
SKIP_SDK_PUBLISH='true'
```

2. Create a `data/sources.json` file configured

```bash
cp sources.example.json data/sources.json
```

Then run the container:

```bash
docker run -p 8989:8989 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  audius/ddex:latest
```

The container will:
- Run the server on port 8989
- Run the worker process to poll S3 buckets
- Both processes are managed by PM2

**Note:** The `data` directory should be mounted as a volume to persist `sources.json` and other data files.
