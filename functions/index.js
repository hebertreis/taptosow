const axios = require("axios");
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
const stripeSecretKeyDmv = defineSecret("STRIPE_SECRET_KEY_DMV");
const stripeSecretKeyCre8 = defineSecret("STRIPE_SECRET_KEY_CRE8");
const stripeSecretKeyBsyym = defineSecret("STRIPE_SECRET_KEY_BSYYM");


// 🔐 SECURE: Define Cora secrets
const coraCert = defineSecret("CORA_CERT");
const coraKey = defineSecret("CORA_KEY");
const coraClientId = defineSecret("CORA_CLIENT_ID");

// 🔐 SECURE: Define PagBank secrets
const pagbankToken = defineSecret("PAGBANK_TOKEN");

const CoraClient = require('./src/cora');
const { seedTenants } = require('./src/seedTenants');

// --- PAGBANK GOOGLE PAY FUNCTION ---
exports.createPagBankOrder = onRequest(
  {
    cors: true,
    maxInstances: 3,
    secrets: [pagbankToken]
  },
  async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    try {
      const { amount, googlePayToken, customer, referenceId } = req.body;
      const token = pagbankToken.value();

      if (!token) {
        logger.error('PagBank token not configured');
        return res.status(500).json({ error: 'PagBank configuration missing' });
      }

      const axios = require('axios');
      const isSandbox = true; // Set to false for production
      const baseUrl = isSandbox ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';

      const orderPayload = {
        reference_id: referenceId || `order-${Date.now()}`,
        customer: {
          name: customer?.name || "Pagador IARCA",
          email: customer?.email || "contato@iarca.org",
          tax_id:  "33586973802", //customer?.document?.replace(/\D/g, '') || remover meu CPF e colocar um genérico
          phones: [{ country: "55", area: "11", number: "999999999", type: "MOBILE" }]
        },
        items: [{
          name: "Doação IARCA Church",
          quantity: 1,
          unit_amount: Math.round(amount * 100)
        }],
        charges: [{
          reference_id: `charge-${Date.now()}`,
          amount: { value: Math.round(amount * 100), currency: "BRL" },
          payment_method: {
            type: "CREDIT_CARD",
            installments: 1,
            capture: true,
            card: {
              wallet: {
                type: "GOOGLE_PAY",
                key: googlePayToken
              }
            }
          }
        }]
      };

      logger.info('Sending order to PagBank', { referenceId: orderPayload.reference_id });

      const response = await axios.post(`${baseUrl}/orders`, orderPayload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      logger.info('PagBank response success', { orderId: response.data.id });
      res.json(response.data);

    } catch (error) {
      const errorData = error.response?.data || error.message;
      logger.error('Error creating PagBank order:', errorData);
      res.status(500).json({
        error: 'Failed to process PagBank payment',
        details: errorData
      });
    }
  }
);

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
    secrets: [stripeSecretKey,stripeSecretKeyDmv,stripeSecretKeyCre8,stripeSecretKeyBsyym] // Make secret available to this function
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
      //Lookup for the domain in request headers if needed for multi-tenant logic then select which stripeSecretKey to use
      const domain = req.get('Origin') || req.get('Referer') || 'unknown';
      logger.info('createPaymentIntent called from domain:', domain);

      if(domain.includes('rcsp.com.br') || domain.includes('rcsp.onetapgo.site') || domain.includes('wasser-c430a.web.app') || domain.includes('cre8.onetapgo.site')) {
        logger.info('Using CRE8 Connect Stripe configuration');
        secretKeyValue = stripeSecretKeyCre8.value();
      }else if(domain.includes('taptosow-staging.web.app') || domain.includes('dmv.onetapgo.site') || domain.includes('rampchurchdmv.onetapgo.site') || domain.includes('rampdmv.web.app')){
        logger.info('Using DMV Stripe Account configuration');
        secretKeyValue = stripeSecretKeyDmv.value();
      }else if(domain.includes('bishopyounger.com', 'bsyym.onetapgo.site')){
        logger.info('Using Bishopyounger Stripe configuration');
        secretKeyValue = stripeSecretKeyBsyym.value();
      }else if(domain.includes('onetapgo.site')){
        logger.info('Using OneTapGo Default Stripe configuration for onetapgo.site');
        secretKeyValue = stripeSecretKey.value();
      } else {
        logger.info('Using OneTapGo Default Stripe configuration');
        secretKeyValue = stripeSecretKey.value(); 
      }
      
          // 🔐 SECURE: Get Stripe secret key from Firebase v2 Secret Manager
      //const secretKeyValue = stripeSecretKey.value();

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
      const { amount: rawAmount, currency = 'usd', metadata = {}, stripeAccountId, customer = {}, paymentMethodTypes = ['card','apple_pay','google_pay','link','amazon_pay','crypto'] } = req.body;

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

      // Add customer specific data to metadata if provided
      // if (customer.name) paymentIntentMetadata.customer_name = customer.name;
      // if (customer.email) paymentIntentMetadata.customer_email = customer.email;

      // // Handle CPF/CNPJ for BRL currency
      // if (currency.toLowerCase() === 'brl' || customer.taxId) {
      //   need to read and implement https://docs.stripe.com/api/tax_ids/customer_create
      // }

      // Add ZIP code if provided
      // if (customer.zipCode) {
      //   paymentIntentMetadata.postal_code = customer.zipCode;
      // }

      //payment_method_types: paymentMethodTypes

      const paymentIntentOptions = {
        amount: amountInCents,
        currency: currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: paymentIntentMetadata,
        
      };

      logger.info('Payment Intent options prepared:', paymentIntentOptions);
      const paymentIntent = await stripe.paymentIntents.create(paymentIntentOptions, { stripeAccount: accountId });

      logger.info('Payment Intent created:', paymentIntentOptions, { paymentIntentId: paymentIntent.id },paymentIntent);

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

// Get Stripe Public Key for Frontend
exports.getStripePublicKey = onRequest(
  {
    cors: true,
    maxInstances: 3,
  },
  async (req, res) => {
    // CORS preflight
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    try {
      const db = admin.firestore();
      const domain = req.get('Origin') || req.get('Referer') || ''; // Re-added domain declaration
      const uri = req.path || ''; // Get URI from req.path
      logger.info('getStripePublicKey called from domain:', domain, 'and URI:', uri);

      let tenantSlug = 'default'; // Default tenant

      // Determine tenant based on domain or URI
      // This logic should mirror the one in createPaymentIntent for consistency
      if (domain.includes('rampchurchdmv.onetapgo.site') || domain.includes('rampdmv.web.app') || uri.includes('/rampchurchdmv')) {
        tenantSlug = 'rampchurchdmv';
      } else if (domain.includes('cre8.onetapgo.site') || domain.includes('rcsp.onetapgo.site') || domain.includes('wasser-c430a.web.app') || uri.includes('/cre8onetapgo')) {
        tenantSlug = 'cre8onetapgo';
      } else if (domain.includes('bsyym.onetapgo.site') || domain.includes('bishopyounger.com') || uri.includes('/bishopsyyoungerministries')) {
        tenantSlug = 'bishopsyyoungerministries';
      } else if (domain.includes('rampchurchsp.onetapgo.site') || domain.includes('rcsp.com.br') || uri.includes('/rampchurchsp')) {
        tenantSlug = 'rampchurchsp';
      } else if (domain.includes('syyounger.onetapgo.site') || uri.includes('/syyounger')) {
        tenantSlug = 'syyounger';
      } else if (domain.includes('owci.onetapgo.site') || uri.includes('/onewaychurches')) {
        tenantSlug = 'onewaychurches';
      } else if (domain.includes('onetapgo.site')) {
        tenantSlug = 'default';
      }

      const tenantDoc = await db.collection('tenants').doc(tenantSlug).get();

      if (!tenantDoc.exists) {
        logger.warn(`Tenant config not found for slug: ${tenantSlug}. Falling back to default.`);
        const defaultTenantDoc = await db.collection('tenants').doc('default').get();
        if (defaultTenantDoc.exists && defaultTenantDoc.data().stripePublicKey) {
            res.json({ publicKey: defaultTenantDoc.data().stripePublicKey });
            return;
        }
        throw new Error('Default tenant or public key not found');
      }

      const tenantData = tenantDoc.data();
      if (!tenantData.stripePublicKey) {
        logger.warn(`stripePublicKey not found for tenant: ${tenantSlug}. Falling back to default.`);
         const defaultTenantDoc = await db.collection('tenants').doc('default').get();
        if (defaultTenantDoc.exists && defaultTenantDoc.data().stripePublicKey) {
            res.json({ publicKey: defaultTenantDoc.data().stripePublicKey });
            return;
        }
        throw new Error('Public key not found for tenant and default also missing');
      }

      res.json({ publicKey: tenantData.stripePublicKey });

    } catch (error) {
      logger.error('Error fetching Stripe Public Key:', error);
      res.status(500).json({ error: 'Internal server error fetching public key' });
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
    const db = admin.firestore();

    try {
        // 1. Handling Sync (?deviceId=...)
        if (path.includes('/sync')) {
            const { deviceId } = req.query;
            if (!deviceId) return res.status(400).send("Missing deviceId");

            const deviceRef = db.collection('devices').doc(deviceId);
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

            const batch = db.batch();
            const deviceRef = db.collection('devices').doc(device_id);

            batch.set(deviceRef, {
                live_feedback: {
                    last_uid: uid,
                    last_result: success ? 'SUCCESS' : 'ERROR',
                    message: success ? `Tag ${uid} vinculada (${mode_executed})` : "Falha no processo",
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                }
            }, { merge: true });

            if (success && mode_executed === 'RECORDER') {
                const deviceDoc = await deviceRef.get();
                const client_slug = deviceDoc.data()?.config?.target_client_slug || "default";
                const tagRef = db.collection('tags').doc(uid);
                batch.set(tagRef, { uid, client_slug, provisioned_by: device_id, provisioned_at: admin.firestore.FieldValue.serverTimestamp(), status: 'active' }, { merge: true });
            }
            await batch.commit();
            return res.json({ success: true });
        }

        // 3. Handling Redirects for /a and /go
        if (path.startsWith('/a')) {
            const parts = path.split('/').filter(Boolean);
            const id = parts[1];

            if (id) {
                // Handle /a/:id
                const tagDoc = await db.collection('tags').doc(id).get();
                if (tagDoc.exists) {
                    const tagData = tagDoc.data();
                    await tagDoc.ref.update({ scan_count: admin.firestore.FieldValue.increment(1) });
                    const targetUrl = [
                        tagData.redirect_url,
                        tagData.redirect_override,
                        tagData.target_url,
                        tagData.url,
                        tagData.redirectUrl
                    ].find((value) => typeof value === 'string' && value.trim().length > 0);

                    if (targetUrl) {
                        return res.redirect(302, targetUrl.trim());
                    }

                    const clientSlug = tagData.client_slug || tagData.clientSlug;
                    if (clientSlug) {
                        const clientDoc = await db.collection('clients').doc(clientSlug).get();
                        const clientBaseUrl = clientDoc.data()?.base_url;
                        if (typeof clientBaseUrl === 'string' && clientBaseUrl.trim().length > 0) {
                            return res.redirect(302, clientBaseUrl.trim());
                        }
                    }
                }
                // If tag not found or has no URL, use fallback
                const fallbackDoc = await db.doc('site_config/fallback').get();
                const fallbackUrl = fallbackDoc.exists ? fallbackDoc.data().url : '/';
                return res.redirect(302, fallbackUrl);

            } else {
                // Handle /a (same as old redirectAuto)
                const doc = await db.doc('site_config/auto_redirect').get();
                if (doc.exists && doc.data().url) {
                    const { url, type } = doc.data();
                    const code = type === 301 ? 301 : 302;
                    return res.redirect(code, url);
                }
                return res.redirect(302, '/'); // Default fallback
            }
        }

        if (path.startsWith('/go/')) {
            const parts = path.split('/').filter(p => p && p !== 'go');
            if (parts.length < 2) return res.redirect(302, '/');
            const [slug, uid] = parts;

            const tagDoc = await db.collection('tags').doc(uid).get();
            let target_url = '/';

            if (tagDoc.exists) {
                const tagData = tagDoc.data();
                await tagDoc.ref.update({ scan_count: admin.firestore.FieldValue.increment(1) });
                const clientDoc = await db.collection('clients').doc(slug).get();
                target_url = tagData.redirect_override || clientDoc.data()?.base_url || '/';
            } else {
                const clientDoc = await db.collection('clients').doc(slug).get();
                target_url = clientDoc.data()?.base_url || '/';
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

// Get Tenant details by slug
exports.getTenantBySlug = onRequest(
  {
    cors: true,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    try {
      const slug = req.query.slug || req.body.slug;

      if (!slug) {
        logger.warn('getTenantBySlug: Missing slug parameter');
        return res.status(400).json({ error: 'Slug is required' });
      }

      logger.info(`Fetching tenant details for slug: ${slug}`);
      const db = admin.firestore();
      const tenantDoc = await db.collection('tenants').doc(slug).get();

      if (!tenantDoc.exists) {
        logger.warn(`Tenant not found: ${slug}`);
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const tenantData = tenantDoc.data();
      
      return res.json({
        success: true,
        tenant: {
          slug: slug,
          ...tenantData
        }
      });

    } catch (error) {
      logger.error('Error in getTenantBySlug:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);


// --- FORM SUBMISSION HANDLER ---
exports.submitForm = onRequest({ cors: true, maxInstances: 10 }, async (req, res) => {
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
        const formData = req.body;
        const db = admin.firestore();
        const now = admin.firestore.FieldValue.serverTimestamp();

        // Extract UTM parameters and origin URL
        const utmParams = {};
        const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
        utmKeys.forEach(key => {
            if (formData[key]) {
                utmParams[key] = formData[key];
            }
        });

        const originUrl = formData.origin_url || req.get('Referer') || 'Unknown';

        // Enrich data
        const submissionData = {
            ...formData,
            utm_parameters: utmParams,
            origin_url: originUrl,
            server_timestamp: now,
            ip_address: req.ip,
            user_agent: req.get('User-Agent'),
        };

        // Save to Firestore
        const docRef = await db.collection('form_submissions').add(submissionData);
        logger.info(`Form submission saved with ID: ${docRef.id}`, { submissionData });

        // Webhook notification if requested
        const webhookUrl = formData.webhook_url || formData.webhook;
        if (webhookUrl && typeof webhookUrl === 'string') {
            try {
                await axios.post(webhookUrl, submissionData);
                logger.info(`Webhook sent successfully to: ${webhookUrl}`);
            } catch (webhookError) {
                logger.error(`Failed to send webhook to ${webhookUrl}:`, webhookError.message);
                // We don't fail the response if the webhook fails, but we log it.
            }
        }

        return res.status(200).json({
            success: true,
            submission_id: docRef.id,
            message: 'Submission received and saved.'
        });

    } catch (error) {
        logger.error("Error in submitForm function:", error);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});
