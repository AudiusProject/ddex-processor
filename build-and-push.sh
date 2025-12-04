#!/bin/bash

# Script to build and push the ddex-processor Docker image
# Usage: ./build-and-push.sh [version]
# Example: ./build-and-push.sh v1.0.0
# If no version is provided, it will use 'latest'

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Docker image name
IMAGE_NAME="audius/ddex"
VERSION="${1:-latest}"

# Ensure buildx is available
if ! docker buildx version &> /dev/null; then
    echo -e "${YELLOW}Warning: docker buildx not found. Installing...${NC}"
    echo "Please ensure Docker Buildx is installed for cross-platform builds."
    exit 1
fi

# Create and use a buildx builder if it doesn't exist
BUILDER_NAME="ddex-builder"
if ! docker buildx inspect "${BUILDER_NAME}" &> /dev/null; then
    echo -e "${GREEN}Creating buildx builder: ${BUILDER_NAME}${NC}"
    docker buildx create --name "${BUILDER_NAME}" --use
else
    # Ensure the builder is in use
    docker buildx use "${BUILDER_NAME}" 2>/dev/null || true
fi

echo -e "${GREEN}Building Docker image: ${IMAGE_NAME}:${VERSION}${NC}"

# Ask if user wants to push (which determines build strategy)
read -p "Do you want to build for multiple platforms and push? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Build for multiple platforms and push directly
    echo -e "${GREEN}Building for linux/amd64,linux/arm64 and pushing...${NC}"
    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      --push \
      -t "${IMAGE_NAME}:${VERSION}" \
      -t "${IMAGE_NAME}:latest" \
      .
    
    echo -e "${GREEN}Build and push complete!${NC}"
else
    # Build for local platform only (loads into local Docker)
    echo -e "${GREEN}Building for local platform...${NC}"
    docker buildx build \
      --load \
      -t "${IMAGE_NAME}:${VERSION}" \
      -t "${IMAGE_NAME}:latest" \
      .
    
    echo -e "${GREEN}Build complete!${NC}"
    echo ""
    echo -e "${YELLOW}To push the image later, run:${NC}"
    echo "  docker push ${IMAGE_NAME}:${VERSION}"
    if [ "$VERSION" != "latest" ]; then
        echo "  docker push ${IMAGE_NAME}:latest"
    fi
fi

