# Firebase Functions v2 Secret Migration Guide

## 🔄 What Changed

Your Firebase Functions code has been updated from the **deprecated** `functions.config()` approach to the new **Firebase Functions v2 Secret Manager** approach for enhanced security.

### ❌ Before (Deprecated - Will Stop Working Dec 2025)
```javascript
const functions = require("firebase-functions");

// This is deprecated and insecure
const stripeSecretKey = functions.config().stripe?.secret_key;
```

### ✅ After (Firebase v2 - Secure & Future-Proof)
```javascript
const {defineSecret} = require("firebase-functions/params");

// Secure secret management with Google Secret Manager
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

exports.createPaymentIntent = onRequest(
  { secrets: [stripeSecretKey] }, // Make secret available
  async (req, res) => {
    const secretKeyValue = stripeSecretKey.value(); // Access the secret
    // ...
  }
);
```

## 🔐 Security Improvements

| Aspect | Old Method | New Method |
|--------|------------|------------|
| **Storage** | Firebase environment config | Google Secret Manager |
| **Security** | Basic environment variables | Encrypted, versioned secrets |
| **Access Control** | Function-level | Fine-grained IAM control |
| **Validation** | Runtime errors | Deploy-time validation |
| **Audit Trail** | Limited | Full audit logs |

## 📋 Migration Steps

### 1. Run the Migration Script
```bash
./migrate-to-v2-secrets.sh
```

### 2. Manual Setup (Alternative)

#### Enable Secret Manager API
```bash
# Visit: https://console.cloud.google.com/apis/library/secretmanager.googleapis.com
# Or use gcloud CLI:
gcloud services enable secretmanager.googleapis.com
```

#### Set Your Stripe Secret Key
```bash
firebase functions:secrets:set STRIPE_SECRET_KEY
# Enter your key when prompted: sk_test_...
```

#### Create Local Testing File
```bash
# Create functions/.secret.local for local development
echo "STRIPE_SECRET_KEY=sk_test_your_test_key_here" > functions/.secret.local

# Add to .gitignore
echo ".secret.local" >> functions/.gitignore
```

### 3. Deploy
```bash
firebase deploy --only functions
```

## 🧪 Local Development

### Testing with Firebase Emulator
1. Add your test keys to `functions/.secret.local`:
   ```
   STRIPE_SECRET_KEY=sk_test_your_test_key_here
   ```

2. Start the emulator:
   ```bash
   firebase emulators:start --only functions
   ```

3. Test your function at: `http://localhost:5001/your-project/us-central1/createPaymentIntent`

## 🔍 Key Changes in Code

### Import Changes
```javascript
// Added secret management
const {defineSecret} = require("firebase-functions/params");

// Define the secret
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
```

### Function Declaration Changes
```javascript
exports.createPaymentIntent = onRequest(
  { 
    cors: true,
    maxInstances: 10,
    secrets: [stripeSecretKey] // ← NEW: Make secret available
  }, 
  async (req, res) => {
    // ...
  }
);
```

### Secret Access Changes
```javascript
// OLD: functions.config().stripe?.secret_key
// NEW: stripeSecretKey.value()

const secretKeyValue = stripeSecretKey.value();
if (!secretKeyValue || secretKeyValue.length === 0) {
  // Handle missing secret
}
```

## 🚨 Error Handling

The new implementation provides better error messaging:

```json
{
  "success": false,
  "error": "🔑 Stripe Secret Key Missing",
  "instructions": [
    "1. Configure securely: firebase functions:secrets:set STRIPE_SECRET_KEY",
    "2. Enter your Stripe secret key when prompted (sk_test_...)",
    "3. Deploy: firebase deploy --only functions",
    "4. Your key is stored securely in Google Secret Manager! 🔐"
  ],
  "security_note": "Keys stored in Google Secret Manager - never in source code! 🔐",
  "migration_note": "Updated to Firebase Functions v2 with enhanced security"
}
```

## 🧹 Cleanup Old Configuration

Once you've confirmed the new setup works, remove old configuration:

```bash
# Remove old config
firebase functions:config:unset stripe

# Verify it's gone
firebase functions:config:get
```

## 📚 Best Practices

### 🔐 Security
- ✅ Use Secret Manager for all sensitive data
- ✅ Use test keys (`sk_test_`) for development
- ✅ Use live keys (`sk_live_`) only for production
- ✅ Never commit secrets to version control
- ✅ Enable audit logging for secret access

### 🚀 Performance
- ✅ Define secrets at module level, not inside functions
- ✅ Use `onInit()` callback for global initialization
- ✅ Set appropriate `maxInstances` for cost control
- ✅ Enable CORS at function level for better performance

### 🛠️ Development
- ✅ Use `.secret.local` for local testing
- ✅ Validate secrets at deploy time
- ✅ Provide clear error messages
- ✅ Test with Firebase Emulator before deploying

## 🆘 Troubleshooting

### "Secret Manager API has not been used"
**Solution:** Enable the API:
```bash
# Visit: https://console.cloud.google.com/apis/library/secretmanager.googleapis.com
# Or use CLI: gcloud services enable secretmanager.googleapis.com
```

### "Secret not found" in local development
**Solution:** Add to `functions/.secret.local`:
```
STRIPE_SECRET_KEY=sk_test_your_key_here
```

### "Permission denied" errors
**Solution:** Check IAM permissions for Secret Manager

### Function deployment fails
**Solution:** Ensure all secrets are configured before deploying

## 📖 Additional Resources

- [Firebase Functions v2 Documentation](https://firebase.google.com/docs/functions/config-env)
- [Google Secret Manager](https://cloud.google.com/secret-manager/docs)
- [Firebase Functions Migration Guide](https://firebase.google.com/docs/functions/2nd-gen-upgrade)
- [Stripe API Keys Documentation](https://stripe.com/docs/keys)

## 🎉 Benefits of Migration

✅ **Enhanced Security**: Secrets stored in Google Secret Manager  
✅ **Future-Proof**: Compatible with Firebase Functions v2  
✅ **Better Error Handling**: Deploy-time validation  
✅ **Audit Trail**: Full logging of secret access  
✅ **Fine-Grained Access**: IAM-based permissions  
✅ **Version Control**: Secret versioning and rotation  

---

*This migration ensures your Firebase Functions are secure, future-proof, and follow Google Cloud best practices for secret management.*