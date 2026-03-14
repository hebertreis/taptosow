const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const {defineSecret} = require("firebase-functions/params");

// CORS configuration for web requests
const cors = require('cors')({ origin: true });

// Admin SDK for Realtime Database access
const admin = require('firebase-admin');
admin.initializeApp();

// 🔐 SECURE: Define Stripe secret key using Firebase v2 Secret Manager
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

// Create Payment Intent for Stripe
exports.createPaymentIntent = onRequest(
  { 
    cors: true,
    maxInstances: 10, // Set max instances for cost control
    secrets: [stripeSecretKey] // Make secret available to this function
  }, 
  async (req, res) => {
  // Handle CORS preflight
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    // 🔐 SECURE: Get Stripe secret key from Firebase v2 Secret Manager
    const secretKeyValue = stripeSecretKey.value();
    
    if (!secretKeyValue || secretKeyValue.length === 0) {
      logger.error('Stripe secret key not configured in Secret Manager');
      res.status(500).json({ 
        success: false,
        error: '🔑 Stripe Secret Key Missing',
        instructions: [
          '1. Configure securely: firebase functions:secrets:set STRIPE_SECRET_KEY',
          '2. Enter your Stripe secret key when prompted (sk_test_...)',
          '3. Deploy: firebase deploy --only functions',
          '4. Your key is stored securely in Google Secret Manager! 🔐'
        ],
        security_note: 'Keys stored in Google Secret Manager - never in source code! 🔐',
        migration_note: 'Updated to Firebase Functions v2 with enhanced security'
      });
      return;
    }
    
    const stripe = require('stripe')(secretKeyValue);
      const { amount: rawAmount, currency = 'brl' } = req.body; // Default to BRL

      // Log incoming request body for debugging discrepancies between UI and Stripe
      logger.info('createPaymentIntent request body:', req.body);

      // Coerce amount to number and normalize to 2 decimal places
      const amount = typeof rawAmount === 'string' ? parseFloat(rawAmount) : rawAmount;
      if (Number.isNaN(amount)) {
        logger.error('Invalid amount received in request:', rawAmount);
        res.status(400).json({ error: 'Invalid amount' });
        return;
      }

      const cents = Math.round(amount * 100);
      const normalizedAmount = cents / 100;
      if (Math.abs(normalizedAmount - amount) > 0.00001) {
        logger.warn('Amount normalized to 2 decimals', { received: amount, normalized: normalizedAmount });
      }
    
    // Validate currency
    const supportedCurrencies = ['brl', 'usd', 'eur', 'gbp', 'cad', 'aud', 'jpy'];
    if (!supportedCurrencies.includes(currency.toLowerCase())) {
      res.status(400).json({ error: 'Unsupported currency' });
      return;
    }
    
    if (!amount || amount <= 0) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }

    // Create a PaymentIntent with Stripe
      const amountInCents = cents; // already computed above
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: currency.toLowerCase(),
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        source: 'Bishop S.Y. Younger International Donations',
        currency: currency.toUpperCase()
      }
    });

    logger.info('Payment Intent created:', { 
      id: paymentIntent.id, 
      amountReceived: amount,
      amountInCents,
      currency: currency.toUpperCase(),
      source: 'Bishop S.Y. Younger International Donations'
    });
    
    res.json({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    logger.error('Error creating payment intent:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Redirect handler for /auto
// Reads fastest available config from Realtime Database at
// /site_config/auto_redirect -> { url: string, type?: 301|302 }
// If no URL found or DB takes longer than 5s to respond, redirect to fallback '/'
exports.redirectAuto = onRequest({ cors: true, maxInstances: 5 }, async (req, res) => {
  // CORS preflight
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const timeoutMs = 5000;
    // Use Firestore for faster lookups (document: site_config/auto_redirect)
    const dbPromise = admin.firestore().doc('site_config/auto_redirect').get().then(doc => doc.exists ? doc.data() : null);
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));

    // Wait for DB or timeout
    const data = await Promise.race([dbPromise, timeoutPromise]);

    if (data && data.url) {
      const code = data.type === 301 || data.type === '301' ? 301 : 302;
      return res.redirect(code, data.url);
    }

    // fallback if no config or DB too slow
    return res.redirect(302, '/');
  } catch (err) {
    logger.error('Error in redirectAuto:', err);
    return res.redirect(302, '/');
  }
});
