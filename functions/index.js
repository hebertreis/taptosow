const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");

// CORS configuration for web requests
const cors = require('cors')({ origin: true });

// Admin SDK for Realtime Database access
const admin = require('firebase-admin');
admin.initializeApp();

// 🔐 SECURE: Define Stripe secret key using Firebase v2 Secret Manager
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

// 🔐 SECURE: Define Cora secrets
const coraCert = defineSecret("CORA_CERT");
const coraKey = defineSecret("CORA_KEY");
const coraClientId = defineSecret("CORA_CLIENT_ID");

const CoraClient = require('./src/cora');
const { seedTenants } = require('./src/seedTenants');

// --- NEW LOGGING FUNCTION ---
exports.logEvent = onRequest({ cors: true, maxInstances: 10 }, async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    try {
        const { eventType, data } = req.body;

        if (!eventType || !data) {
            logger.warn("logEvent: Missing eventType or data", { body: req.body });
            return res.status(400).json({ success: false, error: "Missing eventType or data" });
        }

        const db = admin.firestore();
        const now = admin.firestore.FieldValue.serverTimestamp();

        // Enrich data with server-side information
        const enrichedData = {
            ...data,
            serverTimestamp: now,
            ipAddress: req.ip, // Automatically captured by Cloud Functions
            userAgent: req.get('User-Agent'),
        };

        // 1. Log to a generic 'events' collection for auditing
        const eventLogRef = await db.collection('events').add({
            eventType,
            ...enrichedData,
        });
        logger.info(`Event '${eventType}' logged with ID: ${eventLogRef.id}`, { data });


        // 2. Handle specific event types for structured data
        switch (eventType) {
            case 'payment_intent_success':
                await db.collection('payments').doc(data.stripePaymentIntentId).set({
                    ...enrichedData,
                    status: 'success'
                }, { merge: true });
                logger.info(`Payment record '${data.stripePaymentIntentId}' updated to success.`);
                break;

            case 'payment_intent_failure':
                await db.collection('payments').doc(data.stripePaymentIntentId).set({
                    ...enrichedData,
                    status: 'failed'
                }, { merge: true });
                logger.warn(`Payment record '${data.stripePaymentIntentId}' updated to failed.`);
                break;
            
            case 'payment_intent_initiated':
                 await db.collection('payments').doc(data.stripePaymentIntentId).set({
                    ...enrichedData,
                    status: 'initiated'
                }, { merge: true });
                logger.info(`Payment record '${data.stripePaymentIntentId}' created.`);
                break;

            // Example for other events
            case 'user_profile_update':
                if (data.userId) {
                    await db.collection('users').doc(data.userId).set(data, { merge: true });
                    logger.info(`User profile '${data.userId}' updated.`);
                }
                break;

            default:
                logger.info(`No specific handler for eventType: ${eventType}. Logged to 'events' only.`);
        }

        return res.status(200).json({ success: true, eventId: eventLogRef.id });

    } catch (error) {
        logger.error("Error in logEvent function:", error);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});


// Create Payment Intent for Stripe
exports.createPaymentIntent = onRequest(
  {
    cors: true,
    maxInstances: 3, // Set max instances for cost control
    secrets: [stripeSecretKey] // Make secret available to this function
  },
  async (req, res) => {
    console.log('Received createPaymentIntent request:', req);
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
      const { amount: rawAmount, currency = 'usd', metadata = {}, stripeAccountId } = req.body;

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

      // Extract stripeAccountId from request (from tenant config)
      // Use provided stripeAccountId or fall back to metadata.stripeAccountId
      const accountId = stripeAccountId || metadata.stripeAccountId;

      if (!accountId) {
        logger.error('No stripeAccountId provided in request');
        res.status(400).json({ error: 'Stripe account ID is required' });
        return;
      }

      logger.info('Creating PaymentIntent for Stripe Connect account:', accountId);

      // Create a PaymentIntent with Stripe
      const amountInCents = cents; // already computed above

      // Prepare metadata with stripeAccountId included
      const paymentIntentMetadata = {
        ...metadata,
        stripeAccountId: accountId,
        source: 'OneTapGo Giving Platform',
        currency: currency.toUpperCase(),
      };

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: currency.toLowerCase(),
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: paymentIntentMetadata
      }, {
        stripeAccount: accountId,
      });

      logger.info('Payment Intent created:', {
        id: paymentIntent.id,
        amountReceived: amount,
        amountInCents,
        currency: currency.toUpperCase(),
        source: 'The Ramp Church São Paulo - OneTapGo Giving'
      });

      res.json({
        clientSecret: paymentIntent.client_secret,
      });
    } catch (error) {
      logger.error('Error creating payment intent:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

// Create PIX Charge via Cora
exports.createCoraPixCharge = onRequest(
  {
    cors: true,
    maxInstances: 3,
    secrets: [coraCert, coraKey, coraClientId]
  },
  async (req, res) => {
    // CORS headers
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
      console.log('Creating Cora PIX charge...');
      const cert = coraCert.value();
      const key = coraKey.value();
      const clientId = coraClientId.value(); // Optional, will check if empty

      if (!cert || !key) {
        console.error('Cora certificates not configured');
        res.status(500).json({ error: 'Server configuration error' });
        return;
      }

      const cora = new CoraClient(cert, key, clientId, true);

      const { amount, customer, serviceName, serviceDesc } = req.body;

      // if (!amount || !customer || !customer.name || !customer.document) {
      //   res.status(400).json({ error: 'Missing required fields (amount, customer.name, customer.document)' });
      //   return;
      // }

      const invoice = await cora.createInvoice(amount, customer, serviceName, serviceDesc);

      // Extract PIX info from Cora response
      // Usually in response.payment_options.pix.code or similar
      // Let's assume standard Cora V2 response structure or handle if it's missing
      // Typically: { id, ..., payment_options: { pix: { code: "..." }, bank_slip: { ... } } }

      // Safety check for PIX code
      const pixCode = invoice.pix?.emv || invoice.payment_options?.pix?.code || invoice.pix_emv;

      if (!pixCode) {
        logger.warn('PIX code not found in Cora response', invoice);
        // It might be that the invoice is created but PIX details are elsewhere? 
        // Normally they are in payment_options.
        // We return the whole invoice just in case relevant data is there.
      }

      res.json({
        success: true,
        invoiceId: invoice.id,
        pixCode: pixCode,
        fullResponse: invoice // For debugging/frontend flexibility
      });

    } catch (error) {
      logger.error('Error creating Cora PIX charge:', error);
      res.status(500).json({
        error: 'Failed to create PIX charge',
        details: error.message
      });
    }
  });

// Check PIX Charge status via Cora
exports.checkCoraPixStatus = onRequest(
  {
    cors: true,
    maxInstances: 3,
    secrets: [coraCert, coraKey, coraClientId]
  },
  async (req, res) => {
    // CORS headers
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
      const { invoiceId } = req.body;
      if (!invoiceId) {
        res.status(400).json({ error: 'Missing invoiceId' });
        return;
      }

      const cert = coraCert.value();
      const key = coraKey.value();
      const clientId = coraClientId.value();

      const cora = new CoraClient(cert, key, clientId, true);
      const invoice = await cora.getInvoice(invoiceId);

      res.json({
        success: true,
        status: invoice.status, // OPEN, PAID, CANCELLED, etc.
        invoice: invoice
      });

    } catch (error) {
      logger.error('Error checking Cora PIX status:', error);
      res.status(500).json({
        error: 'Failed to check status',
        details: error.message
      });
    }
  });

// Redirect handler for /auto
// Reads fastest available config from Realtime Database at
// /site_config/auto_redirect -> { url: string, type?: 301|302 }
// If no URL found or DB takes longer than 5s to respond, redirect to fallback '/'
exports.redirectAuto = onRequest({ cors: true, maxInstances: 3 }, async (req, res) => {
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

// verifyApplePayDomain endpoint
// Programmatically registers and verifies a domain for Apple Pay
// Usage: POST { domain: "example.com", stripeAccountId: "acct_..." }
exports.verifyApplePayDomain = onRequest(
  {
    cors: true,
    maxInstances: 3,
    secrets: [stripeSecretKey]
  },
  async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    try {
      const { domain = "wasser-c430a.web.app", stripeAccountId = "acct_1SkWViGa44Ztl1iO" } = req.body;
      const stripe = require('stripe')(stripeSecretKey.value());

      logger.info(`🍎 Verifying Apple Pay domain: ${domain} for account: ${stripeAccountId}`);

      const applePayDomain = await stripe.applePayDomains.create({
        domain_name: domain
      }, {
        stripeAccount: stripeAccountId
      });

      logger.info('✅ Apple Pay domain verified successfully:', applePayDomain);
      res.json({ success: true, data: applePayDomain });
    } catch (error) {
      logger.error('💥 Error verifying Apple Pay domain:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        details: 'Ensure the file is available at https://[domain]/.well-known/apple-developer-merchantid-domain-association'
      });
    }
  }
);

// One-time Seed Function
exports.iotSeed = onRequest({ cors: true, maxInstances: 1 }, async (req, res) => {
  try {
    const clients = [
      { id: 'default', name: 'OneTapGo (Default)', base_url: 'https://onetapgo.site' },
      { id: 'the-ramp', name: 'The Ramp Church', base_url: 'https://theramp.com.br' }
    ];
    for (const c of clients) {
      await admin.firestore().collection('clients').doc(c.id).set({
        name: c.name, base_url: c.base_url, created_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    res.send("Seed OK! Clientes criados.");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// IoT Unified Router (Sync, Event, Redirect)
// Consolidating to single function to bypass CPU Quota limits
exports.iotRouter = onRequest({ cors: true, maxInstances: 5, memory: "256MiB" }, async (req, res) => {
  const path = req.path;

  try {
    // 1. Handling Sync (?deviceId=...)
    if (path.includes('/sync')) {
      const { deviceId } = req.query;
      if (!deviceId) return res.status(400).send("Missing deviceId");

      const deviceRef = admin.firestore().collection('devices').doc(deviceId);
      const doc = await deviceRef.get();
      await deviceRef.set({ last_seen: admin.firestore.FieldValue.serverTimestamp(), status: 'online' }, { merge: true });

      if (!doc.exists) {
        const defaultConfig = { mode: "RECORDER", target_client_slug: "default" };
        await deviceRef.set({ label: "Novo Dispositivo", config: defaultConfig }, { merge: true });
        return res.json(defaultConfig);
      }
      return res.json(doc.data().config || {});
    }

    // 2. Handling Event (POST payload)
    if (path.includes('/event')) {
      const { device_id, uid, action, success, mode_executed } = req.body;
      if (!device_id || !uid) return res.status(400).send("Missing payload");

      const batch = admin.firestore().batch();
      const deviceRef = admin.firestore().collection('devices').doc(device_id);

      batch.set(deviceRef, {
        live_feedback: {
          last_uid: uid, last_result: success ? 'SUCCESS' : 'ERROR',
          message: success ? `Tag ${uid} vinculada (${mode_executed})` : "Falha no processo",
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        }
      }, { merge: true });

      if (success && mode_executed === 'RECORDER') {
        const deviceDoc = await deviceRef.get();
        const client_slug = deviceDoc.data()?.config?.target_client_slug || "default";
        const tagRef = admin.firestore().collection('tags').doc(uid);
        batch.set(tagRef, { uid, client_slug, provisioned_by: device_id, provisioned_at: admin.firestore.FieldValue.serverTimestamp(), status: 'active' }, { merge: true });
      }
      await batch.commit();
      return res.json({ success: true });
    }

    // 3. Handling Redirect (/go/:slug/:uid)
    if (path.startsWith('/go/')) {
      const parts = path.split('/').filter(p => p && p !== 'go');
      if (parts.length < 2) return res.redirect(302, '/');
      const [slug, uid] = parts;

      const tagDoc = await admin.firestore().collection('tags').doc(uid).get();
      let target_url = '/';

      if (tagDoc.exists) {
        const tagData = tagDoc.data();
        await tagDoc.ref.update({ scan_count: admin.firestore.FieldValue.increment(1) });
        target_url = tagData.redirect_override || (await admin.firestore().collection('clients').doc(slug).get()).data()?.base_url || '/';
      } else {
        target_url = (await admin.firestore().collection('clients').doc(slug).get()).data()?.base_url || '/';
      }
      return res.redirect(302, target_url);
    }

    res.status(404).send("IoT Path Not Found");
  } catch (error) {
    logger.error("iotRouter error:", error);
    res.status(500).send(error.message);
  }
});

exports.seedTenantsFunction = onRequest({ cors: true, maxInstances: 1 }, async (req, res) => {
  // Handle CORS preflight
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); // Allow GET for simple triggering
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    // You might want to add authentication/authorization here in a production environment
    // For now, it's a simple trigger.
    await seedTenants();
    res.status(200).send('Tenant seeding initiated successfully!');
  } catch (error) {
    logger.error('Error in seedTenantsFunction:', error);
    res.status(500).send(`Error seeding tenants: ${error.message}`);
  }
});