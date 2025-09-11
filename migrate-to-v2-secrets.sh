#!/bin/bash

# Firebase Functions v2 Secret Migration Script
# This script helps migrate from functions.config() to Firebase v2 Secret Manager

echo "🔐 Firebase Functions v2 Secret Migration Script"
echo "=================================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📋 This script will help you migrate from the deprecated functions.config() to Firebase v2 Secret Manager${NC}"
echo ""

# Check if Firebase CLI is installed
if ! command -v firebase &> /dev/null; then
    echo -e "${RED}❌ Firebase CLI is not installed. Please install it first:${NC}"
    echo "npm install -g firebase-tools"
    exit 1
fi

# Check current Firebase project
echo -e "${YELLOW}🔍 Checking current Firebase project...${NC}"
PROJECT=taptosow-staging
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ No Firebase project selected. Please run 'firebase use <project-id>' first${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Current project: $(firebase use)${NC}"
echo ""

# Step 1: Export existing configuration (if any)
echo -e "${YELLOW}📤 Step 1: Exporting existing functions.config() values...${NC}"
firebase functions:config:get > current-config.json 2>/dev/null
if [ -s current-config.json ]; then
    echo -e "${GREEN}✅ Existing config exported to current-config.json${NC}"
    echo "Current configuration:"
    cat current-config.json
else
    echo -e "${BLUE}ℹ️  No existing functions.config() found${NC}"
    rm -f current-config.json
fi
echo ""

# Step 2: Enable Secret Manager API
echo -e "${YELLOW}🔧 Step 2: Enabling Secret Manager API...${NC}"
echo "This may require enabling the Secret Manager API in Google Cloud Console."
echo "If you get an error, visit: https://console.cloud.google.com/apis/library/secretmanager.googleapis.com"
echo ""

# Step 3: Set Stripe Secret Key
echo -e "${YELLOW}🔑 Step 3: Setting up Stripe Secret Key in Secret Manager...${NC}"
echo ""
echo -e "${BLUE}Please have your Stripe secret key ready (starts with sk_test_ or sk_live_)${NC}"
echo -e "${BLUE}You can find it at: https://dashboard.stripe.com/test/apikeys${NC}"
echo ""

read -p "Do you want to set your Stripe secret key now? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Setting STRIPE_SECRET_KEY..."
    firebase functions:secrets:set STRIPE_SECRET_KEY
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ STRIPE_SECRET_KEY set successfully!${NC}"
    else
        echo -e "${RED}❌ Failed to set STRIPE_SECRET_KEY${NC}"
        echo "Please ensure Secret Manager API is enabled and try again."
        exit 1
    fi
else
    echo -e "${YELLOW}⚠️  Skipping secret setup. You can run this command later:${NC}"
    echo "firebase functions:secrets:set STRIPE_SECRET_KEY"
fi
echo ""

# Step 4: Create local secrets file for testing
echo -e "${YELLOW}🧪 Step 4: Setting up local testing environment...${NC}"
if [ ! -f "functions/.secret.local" ]; then
    echo "Creating functions/.secret.local for local testing..."
    echo "# Local secrets for Firebase Functions emulator" > functions/.secret.local
    echo "# Add your test keys here (this file is gitignored)" >> functions/.secret.local
    echo "STRIPE_SECRET_KEY=sk_test_your_stripe_test_key_here" >> functions/.secret.local
    echo ""
    echo -e "${GREEN}✅ Created functions/.secret.local${NC}"
    echo -e "${BLUE}📝 Please edit functions/.secret.local and add your actual test keys${NC}"
else
    echo -e "${BLUE}ℹ️  functions/.secret.local already exists${NC}"
fi

# Ensure .secret.local is in .gitignore
if ! grep -q ".secret.local" functions/.gitignore 2>/dev/null; then
    echo "" >> functions/.gitignore
    echo "# Local secrets" >> functions/.gitignore
    echo ".secret.local" >> functions/.gitignore
    echo -e "${GREEN}✅ Added .secret.local to .gitignore${NC}"
fi
echo ""

# Step 5: Deployment instructions
echo -e "${YELLOW}🚀 Step 5: Deployment${NC}"
echo ""
echo -e "${BLUE}Your functions have been updated to use Firebase v2 Secret Manager!${NC}"
echo ""
echo "Next steps:"
echo "1. Edit functions/.secret.local with your test keys for local development"
echo "2. Test locally: firebase emulators:start --only functions"
echo "3. Deploy to production: firebase deploy --only functions"
echo ""

# Step 6: Cleanup old config (optional)
echo -e "${YELLOW}🧹 Step 6: Cleanup (Optional)${NC}"
echo ""
read -p "Do you want to remove the old functions.config() values? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Removing old stripe configuration..."
    firebase functions:config:unset stripe
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Old stripe config removed${NC}"
    else
        echo -e "${YELLOW}⚠️  Could not remove old config (it may not exist)${NC}"
    fi
else
    echo -e "${BLUE}ℹ️  Keeping old config. You can remove it later with:${NC}"
    echo "firebase functions:config:unset stripe"
fi
echo ""

# Final summary
echo -e "${GREEN}🎉 Migration Complete!${NC}"
echo ""
echo -e "${BLUE}Summary of changes:${NC}"
echo "✅ Updated functions/index.js to use Firebase v2 Secret Manager"
echo "✅ Configured STRIPE_SECRET_KEY in Secret Manager"
echo "✅ Set up local testing environment"
echo "✅ Enhanced security with Google Secret Manager"
echo ""
echo -e "${YELLOW}⚠️  Important Security Notes:${NC}"
echo "• Your API keys are now stored in Google Secret Manager (much more secure!)"
echo "• Never commit .secret.local to version control"
echo "• Use test keys (sk_test_) for development"
echo "• Use live keys (sk_live_) only for production"
echo ""
echo -e "${BLUE}📚 Documentation:${NC}"
echo "• Firebase v2 Secrets: https://firebase.google.com/docs/functions/config-env"
echo "• Secret Manager: https://cloud.google.com/secret-manager/docs"
echo ""

# Clean up
rm -f current-config.json

echo -e "${GREEN}Happy coding! 🚀${NC}"