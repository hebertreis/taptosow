#!/bin/bash

# Script to upload multiline secrets to Firebase Functions
# Usage: ./upload-cora-keys.sh

echo "----------------------------------------------------------------"
echo "  Upload Cora Secrets to Firebase"
echo "----------------------------------------------------------------"
echo "This script safely uploads multiline certificates and keys."
echo ""

# Function to upload a secret
upload_secret() {
  local secret_name=$1
  local file_path=$2
  local display_name=$3

  echo "Processing $secret_name ($display_name)..."

  if [ -f "$file_path" ]; then
    echo "  Found file: $file_path"
    echo "  Uploading..."
    firebase functions:secrets:set "$secret_name" < "$file_path"
  else
    echo "  File '$file_path' not found."
    echo "  Please paste the content for $secret_name (press Ctrl+D on a new line when finished):"
    
    # Create a temporary file
    temp_file=$(mktemp)
    
    # Read user input into the temp file
    cat > "$temp_file"
    
    echo "  Uploading from input..."
    firebase functions:secrets:set "$secret_name" < "$temp_file"
    
    # Remove temp file
    rm "$temp_file"
  fi
  
  echo "  Done."
  echo ""
}

# Main execution
upload_secret "CORA_CERT" "cora.cert.pem" "Certificate (PEM)"
upload_secret "CORA_KEY" "cora.key.pem" "Private Key (PEM)"
upload_secret "CORA_CLIENT_ID" "cora_client_id.txt" "Client ID"

echo "----------------------------------------------------------------"
echo "  All secrets processed."
echo "  You may need to redeploy functions for changes to take effect."
echo "----------------------------------------------------------------"
