#!/bin/bash
# Script to create sealed secrets for ateliercode-server
# Run this from WSL or a Linux/Mac environment with kubectl and kubeseal installed

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}AtelierCode Server - Sealed Secret Generator${NC}"
echo "============================================="
echo ""

# Check if kubeseal is installed
if ! command -v kubeseal &> /dev/null; then
    echo -e "${RED}Error: kubeseal is not installed${NC}"
    echo "Install it with: brew install kubeseal (Mac) or download from GitHub"
    exit 1
fi

# Check kubectl context
CONTEXT=$(kubectl config current-context)
echo -e "Current kubectl context: ${GREEN}${CONTEXT}${NC}"
read -p "Is this the correct cluster? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Please switch to the correct context with: kubectl config use-context <context-name>"
    exit 1
fi

echo ""
echo "Please enter the secret values:"
echo ""

# Prompt for values
read -p "JWT Secret (min 64 chars, leave empty to generate): " JWT_SECRET
if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET=$(openssl rand -base64 48)
    echo -e "Generated JWT Secret: ${GREEN}${JWT_SECRET}${NC}"
fi

read -p "PostgreSQL Password: " PG_PASSWORD
if [ -z "$PG_PASSWORD" ]; then
    echo -e "${RED}Error: PostgreSQL password is required${NC}"
    exit 1
fi

read -p "TURN Credential (from COTURN): " TURN_CREDENTIAL
if [ -z "$TURN_CREDENTIAL" ]; then
    echo -e "${RED}Error: TURN credential is required${NC}"
    exit 1
fi

# Construct database URL
DATABASE_URL="postgresql://ateliercode:${PG_PASSWORD}@ateliercode-server-postgresql:5432/ateliercode"

echo ""
echo "Creating temporary secret file..."

# Create temporary secret
cat > /tmp/ateliercode-secrets.yaml << EOF
apiVersion: v1
kind: Secret
metadata:
  name: ateliercode-server-secrets
  namespace: default
type: Opaque
stringData:
  jwt-secret: "${JWT_SECRET}"
  database-url: "${DATABASE_URL}"
  turn-credential: "${TURN_CREDENTIAL}"
EOF

echo "Sealing secret..."

# Seal the secret
kubeseal --controller-name=sealed-secrets-controller \
         --controller-namespace=kube-system \
         --format yaml < /tmp/ateliercode-secrets.yaml > sealed-secrets.yaml

# Clean up
rm /tmp/ateliercode-secrets.yaml

echo ""
echo -e "${GREEN}Success!${NC} Sealed secret created: sealed-secrets.yaml"
echo ""
echo "Next steps:"
echo "1. Review the sealed-secrets.yaml file"
echo "2. Apply it to the cluster: kubectl apply -f sealed-secrets.yaml"
echo "3. Commit sealed-secrets.yaml to git (it's safe - values are encrypted)"
echo ""
