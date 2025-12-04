#!/bin/bash

# Script to build and push the ddex-processor Docker image
# Usage: ./build-and-push.sh [version]
# Example: ./build-and-push.sh v1.0.0
# If no version is provided, it will use 'latest'

set -e

# Colors for output
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Docker image name
IMAGE_NAME="audius/ddex"
VERSION="${1:-latest}"

echo -e "${GREEN}Building Docker image: ${IMAGE_NAME}:${VERSION}${NC}"

# Build the Docker image
docker build \
  -t "${IMAGE_NAME}:${VERSION}" \
  -t "${IMAGE_NAME}:latest" \
  .

echo -e "${GREEN}Build complete!${NC}"
echo ""
read -p "Do you want to push the image now? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${GREEN}Pushing ${IMAGE_NAME}:${VERSION}...${NC}"
    docker push "${IMAGE_NAME}:${VERSION}"
    
    if [ "$VERSION" != "latest" ]; then
        echo -e "${GREEN}Pushing ${IMAGE_NAME}:latest...${NC}"
        docker push "${IMAGE_NAME}:latest"
    fi
    
    echo -e "${GREEN}Push complete!${NC}"
fi

