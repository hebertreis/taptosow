const {setGlobalOptions} = require("firebase-functions");
const {onRequest} = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const functions = require("firebase-functions");

// Set global options for cost control
setGlobalOptions({ maxInstances: 10 });

// CORS configuration for web requests
const cors = require('cors')({ origin: true });

// Create Payment Intent for Stripe
exports.createPaymentIntent = onRequest({ cors: true }, async (req, res) => {
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
    // Initialize Stripe with secret key from config
    const stripeSecretKey = functions.config().stripe?.secret_key;
    
    if (!stripeSecretKey) {
      logger.error('Stripe secret key not configured');
      res.status(500).json({ 
        error: 'Stripe configuration missing. Please set the secret key using: firebase functions:config:set stripe.secret_key="sk_test_..."' 
      });
      return;
    }
    
    const stripe = require('stripe')(stripeSecretKey);
    const { amount, currency = 'brl' } = req.body; // Default to BRL
    
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
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
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
      amount, 
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
