const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");
const tls = require('tls');

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

const PIX_WEBHOOK_PROXY_PREFIX = '/api/webhook-pix/';
const PIX_WEBHOOK_PROXY_TARGET_ORIGIN = 'https://giving.onetapgo.site';
const PIX_WEBHOOK_PROXY_TIMEOUT_MS = 15000;
const PIX_WEBHOOK_REDIS_CHANNEL = 'webhook-pix-events';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const REQUEST_HEADER_BLACKLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-length',
  'host'
]);

const RESPONSE_HEADER_BLACKLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-length'
]);

let hasLoggedMissingPixWebhookRedisUrl = false;

function extractPixWebhookCnpj(pathname = '') {
  const normalizedPath = pathname.endsWith('/') && pathname.length > PIX_WEBHOOK_PROXY_PREFIX.length ?
    pathname.slice(0, -1) :
    pathname;

  if (!normalizedPath.startsWith(PIX_WEBHOOK_PROXY_PREFIX)) {
    return null;
  }

  const cnpj = normalizedPath.slice(PIX_WEBHOOK_PROXY_PREFIX.length);
  return /^\d{14}$/.test(cnpj) ? cnpj : null;
}

function buildPixWebhookTargetUrl(req) {
  const originalUrl = req.originalUrl || req.url || req.path || '/';
  return new URL(originalUrl, PIX_WEBHOOK_PROXY_TARGET_ORIGIN).toString();
}

function buildProxyRequestHeaders(headers = {}) {
  const proxyHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (REQUEST_HEADER_BLACKLIST.has(normalizedName)) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => proxyHeaders.append(name, entry));
      continue;
    }

    proxyHeaders.set(name, value);
  }

  proxyHeaders.set('x-proxy-by', 'onetapgo-firebase');

  return proxyHeaders;
}

function applyProxyResponseHeaders(upstreamHeaders, res) {
  if (typeof upstreamHeaders.getSetCookie === 'function') {
    const setCookieHeaders = upstreamHeaders.getSetCookie();
    if (setCookieHeaders.length > 0) {
      res.set('set-cookie', setCookieHeaders);
    }
  }

  upstreamHeaders.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') {
      return;
    }

    if (RESPONSE_HEADER_BLACKLIST.has(name.toLowerCase())) {
      return;
    }

    res.set(name, value);
  });
}

function shouldForwardRequestBody(method = '') {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD';
}

function getPixWebhookRedisUrl() {
  return process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || '';
}

function encodeRedisCommand(parts) {
  const chunks = [`*${parts.length}\r\n`];

  parts.forEach((part) => {
    const value = String(part);
    chunks.push(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
  });

  return chunks.join('');
}

function parseRedisReply(buffer) {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  const prefix = String.fromCharCode(buffer[0]);
  const lineEnd = buffer.indexOf('\r\n');

  if (lineEnd === -1) {
    return null;
  }

  const header = buffer.slice(1, lineEnd).toString();

  if (prefix === '+' || prefix === '-' || prefix === ':') {
    return {
      type: prefix,
      value: header,
      bytesConsumed: lineEnd + 2
    };
  }

  if (prefix === '$') {
    const length = Number.parseInt(header, 10);

    if (Number.isNaN(length)) {
      throw new Error('Invalid Redis bulk reply length');
    }

    if (length === -1) {
      return {
        type: prefix,
        value: null,
        bytesConsumed: lineEnd + 2
      };
    }

    const valueStart = lineEnd + 2;
    const valueEnd = valueStart + length;
    const totalBytes = valueEnd + 2;

    if (buffer.length < totalBytes) {
      return null;
    }

    return {
      type: prefix,
      value: buffer.slice(valueStart, valueEnd).toString(),
      bytesConsumed: totalBytes
    };
  }

  throw new Error(`Unsupported Redis reply type: ${prefix}`);
}

function connectPixWebhookRedis(redisUrlString) {
  return new Promise((resolve, reject) => {
    const redisUrl = new URL(redisUrlString);
    const socket = tls.connect({
      host: redisUrl.hostname,
      port: Number.parseInt(redisUrl.port || '6379', 10),
      servername: redisUrl.hostname
    });

    const cleanup = () => {
      socket.off('secureConnect', onSecureConnect);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };

    const onSecureConnect = () => {
      cleanup();
      resolve({ redisUrl, socket });
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      socket.destroy(new Error('Redis TLS connection timed out'));
      reject(new Error('Redis TLS connection timed out'));
    };

    socket.setTimeout(PIX_WEBHOOK_PROXY_TIMEOUT_MS);
    socket.once('secureConnect', onSecureConnect);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function sendRedisCommand(socket, parts) {
  return new Promise((resolve, reject) => {
    let bufferedResponse = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
    };

    const succeed = (reply) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(reply);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      bufferedResponse = Buffer.concat([bufferedResponse, chunk]);

      let reply;
      try {
        reply = parseRedisReply(bufferedResponse);
      } catch (error) {
        fail(error);
        return;
      }

      if (!reply) {
        return;
      }

      if (reply.type === '-') {
        fail(new Error(`Redis command failed: ${reply.value}`));
        return;
      }

      succeed(reply);
    };

    const onError = (error) => fail(error);
    const onClose = () => fail(new Error('Redis connection closed unexpectedly'));
    const onTimeout = () => fail(new Error('Redis command timed out'));

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('timeout', onTimeout);
    socket.write(encodeRedisCommand(parts));
  });
}

async function publishPixWebhookRedisEvent(payload) {
  const redisUrlString = getPixWebhookRedisUrl();

  if (!redisUrlString) {
    if (!hasLoggedMissingPixWebhookRedisUrl) {
      logger.warn('proxyPixWebhook Redis publish skipped because UPSTASH_REDIS_URL is not configured');
      hasLoggedMissingPixWebhookRedisUrl = true;
    }

    return null;
  }

  let socket;

  try {
    const connection = await connectPixWebhookRedis(redisUrlString);
    const redisUrl = connection.redisUrl;
    socket = connection.socket;

    const username = decodeURIComponent(redisUrl.username || '');
    const password = decodeURIComponent(redisUrl.password || '');

    if (password) {
      const authCommand = username ? ['AUTH', username, password] : ['AUTH', password];
      await sendRedisCommand(socket, authCommand);
    }

    const publishReply = await sendRedisCommand(socket, [
      'PUBLISH',
      process.env.PIX_WEBHOOK_REDIS_CHANNEL || PIX_WEBHOOK_REDIS_CHANNEL,
      JSON.stringify(payload)
    ]);

    await sendRedisCommand(socket, ['QUIT']).catch(() => null);
    socket.end();

    return Number.parseInt(publishReply.value || '0', 10);
  } catch (error) {
    if (socket) {
      socket.destroy();
    }

    logger.error('proxyPixWebhook Redis publish failed', {
      event: payload.event,
      cnpj: payload.cnpj,
      error: error.message
    });

    return null;
  }
}

function publishPixWebhookRedisEventAsync(payload) {
  void publishPixWebhookRedisEvent(payload);
}

exports.proxyPixWebhook = onRequest(
  {
    maxInstances: 5,
    timeoutSeconds: 30
  },
  async (req, res) => {
    const startedAt = Date.now();
    const cnpj = extractPixWebhookCnpj(req.path);

    if (!cnpj) {
      logger.warn('proxyPixWebhook rejected invalid path', {
        method: req.method,
        path: req.path
      });
      res.status(400).json({ error: 'Invalid webhook PIX path' });
      return;
    }

    const targetUrl = buildPixWebhookTargetUrl(req);

    try {
      const upstreamResponse = await fetch(targetUrl, {
        method: req.method,
        headers: buildProxyRequestHeaders(req.headers),
        body: shouldForwardRequestBody(req.method) ? (req.rawBody || Buffer.alloc(0)) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(PIX_WEBHOOK_PROXY_TIMEOUT_MS)
      });

      const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());

      applyProxyResponseHeaders(upstreamResponse.headers, res);

      const durationMs = Date.now() - startedAt;
      const redisPayload = {
        event: 'proxy_success',
        timestamp: new Date().toISOString(),
        method: req.method,
        cnpj,
        path: req.path,
        targetUrl,
        status: upstreamResponse.status,
        durationMs
      };

      logger.info('proxyPixWebhook forwarded request', {
        method: req.method,
        cnpj,
        targetUrl,
        status: upstreamResponse.status,
        durationMs
      });

      res.status(upstreamResponse.status);

      if (req.method.toUpperCase() === 'HEAD') {
        res.end();
        publishPixWebhookRedisEventAsync(redisPayload);
        return;
      }

      res.send(responseBuffer);
      publishPixWebhookRedisEventAsync(redisPayload);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const redisPayload = {
        event: 'proxy_error',
        timestamp: new Date().toISOString(),
        method: req.method,
        cnpj,
        path: req.path,
        targetUrl,
        durationMs,
        error: error.message
      };

      logger.error('proxyPixWebhook upstream request failed', {
        method: req.method,
        cnpj,
        targetUrl,
        durationMs,
        error: error.message
      });

      res.status(502).json({ error: 'Failed to reach upstream webhook' });
      publishPixWebhookRedisEventAsync(redisPayload);
    }
  }
);

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
    const addUtmParameters = (url, tagId, campaign) => {
        if (!url) return url;
        const timestamp = new Date().toISOString();
        const utmParams = new URLSearchParams({
            utm_source: "onetapgo",
            utm_medium: "nfc",
            utm_campaign: campaign || "fallback",
            utm_content: tagId || "unknown",
            utm_timestamp: timestamp
        });

        const joinChar = url.includes("?") ? "&" : "?";
        return `${url.trim()}${joinChar}${utmParams.toString()}`;
    };

    const sendGa4Event = async (tagId, campaign, req) => {
        const measurementId = "G-CD3HYBNK3E";
        const apiSecret = "8uma_U7XQICmqOb_z33H9w";
        const axios = require('axios');
        const { v4: uuidv4 } = require('uuid');

        try {
            const clientId = req.get('X-GA-Client-ID') || uuidv4();
            const payload = {
                client_id: clientId,
                debug_mode: true,
                events: [{
                    name: 'tag_scan',
                    params: {
                        tag_id: tagId,
                        campaign: campaign,
                        source: 'onetapgo',
                        medium: 'nfc',
                        ip_address: req.ip,
                        user_agent: req.get('User-Agent'),
                        engagement_time_msec: '1',
                        session_id: clientId
                    }
                }]
            };

            await axios.post(
                `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}&debug_mode=true`,
                payload
            );
            logger.info("GA4 event sent successfully (debug mode)", { tagId, campaign });
        } catch (error) {
            logger.error("Error sending GA4 event", error.message);
        }
    };

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
                    await tagDoc.ref.update({
                        scan_count: admin.firestore.FieldValue.increment(1),
                        last_scan_at: admin.firestore.FieldValue.serverTimestamp(),
                        updated_at: admin.firestore.FieldValue.serverTimestamp()
                    });

                    const clientSlug = tagData.tenant || tagData.slug || "fallback";
                    const targetUrl = [
                        tagData.redirect_url,
                        tagData.redirect_override,
                        tagData.target_url,
                        tagData.url,
                        tagData.redirectUrl
                    ].find((value) => typeof value === 'string' && value.trim().length > 0);

                    if (targetUrl) {
                        sendGa4Event(id, clientSlug, req).catch(e => logger.error('GA4 error', e));
                        console.info(`Redirecting tag ${id} to URL: ${targetUrl} with clientSlug: ${clientSlug}`);
                    return res.redirect(302, addUtmParameters(targetUrl, id, clientSlug));
                    }

                    if (clientSlug && clientSlug !== "fallback") {
                        const clientDoc = await db.collection('clients').doc(clientSlug).get();
                        const clientBaseUrl = clientDoc.data()?.base_url;
                        if (typeof clientBaseUrl === 'string' && clientBaseUrl.trim().length > 0) {
                            sendGa4Event(id, clientSlug, req).catch(e => logger.error('GA4 error', e));
                            console.info(`Redirecting tag ${id} to client's base URL: ${clientBaseUrl} with clientSlug: ${clientSlug}`);
                            return res.redirect(302, addUtmParameters(clientBaseUrl, id, clientSlug));
                        }
                    }
                }
                // If tag not found or has no URL, use fallback
                const fallbackDoc = await db.doc('site_config/fallback').get();
                const fallbackUrl = fallbackDoc.exists ? fallbackDoc.data().url : '/';
                sendGa4Event(id || 'unknown', 'fallback', req).catch(e => logger.error('GA4 error', e));
                console.info(`Tag ${id} not found or no URL. Redirecting to fallback: ${fallbackUrl}`);
                return res.redirect(302, addUtmParameters(fallbackUrl, id || "unknown", "fallback"));

            } else {
                // Handle /a (same as old redirectAuto)
                const doc = await db.doc('site_config/auto_redirect').get();
                if (doc.exists && doc.data().url) {
                    const { url, type } = doc.data();
                    const code = type === 301 ? 301 : 302;
                    sendGa4Event('auto_redirect', 'fallback', req).catch(e => logger.error('GA4 error', e));
                    return res.redirect(code, addUtmParameters(url, "auto_redirect", "fallback"));
                }
                sendGa4Event('auto_redirect', 'fallback', req).catch(e => logger.error('GA4 error', e));
                return res.redirect(302, addUtmParameters('/', "auto_redirect", "fallback")); // Default fallback
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
                await tagDoc.ref.update({
                    scan_count: admin.firestore.FieldValue.increment(1),
                    last_scan_at: admin.firestore.FieldValue.serverTimestamp(),
                    updated_at: admin.firestore.FieldValue.serverTimestamp()
                });
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

function sanitizeSlug(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function normalizePaymentMethods(paymentMethods = {}) {
  const primary = Array.isArray(paymentMethods.primary) ? paymentMethods.primary : [];
  const secondary = Array.isArray(paymentMethods.secondary) ? paymentMethods.secondary : [];

  return { primary, secondary };
}

function validateGivingOptions(givingOptions) {
  if (!Array.isArray(givingOptions) || givingOptions.length === 0) {
    return 'givingOptions must be a non-empty array';
  }

  const hasInvalidOption = givingOptions.some((option) => {
    return !option ||
      typeof option.id !== 'string' ||
      typeof option.label !== 'string' ||
      typeof option.value !== 'string' ||
      !option.id.trim() ||
      !option.label.trim() ||
      !option.value.trim();
  });

  return hasInvalidOption ?
    'each givingOptions item must include non-empty string fields: id, label, value' :
    null;
}

exports.createTenant = onRequest(
  {
    cors: true,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.set('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
      const {
        slug,
        name,
        domain,
        currency,
        stripeAccountId,
        stripePublicKey,
        pixKey,
        logoUrl,
        givingOptions,
        paymentMethods,
        theme = {},
      } = req.body || {};

      const normalizedSlug = sanitizeSlug(slug);

      if (!normalizedSlug) {
        return res.status(400).json({ error: 'slug is required and must contain only letters, numbers, or hyphens' });
      }

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }

      if (!currency || typeof currency !== 'string' || !currency.trim()) {
        return res.status(400).json({ error: 'currency is required' });
      }

      const givingOptionsError = validateGivingOptions(givingOptions);
      if (givingOptionsError) {
        return res.status(400).json({ error: givingOptionsError });
      }

      if (!theme.primaryColor || typeof theme.primaryColor !== 'string' || !theme.primaryColor.trim()) {
        return res.status(400).json({ error: 'theme.primaryColor is required' });
      }

      const db = admin.firestore();
      const tenantRef = db.collection('tenants').doc(normalizedSlug);
      const existingTenant = await tenantRef.get();

      if (existingTenant.exists) {
        return res.status(409).json({ error: 'Tenant already exists', slug: normalizedSlug });
      }

      const normalizedTenant = {
        id: normalizedSlug,
        slug: normalizedSlug,
        name: name.trim(),
        domain: typeof domain === 'string' && domain.trim() ? domain.trim().toLowerCase() : null,
        currency: currency.trim().toLowerCase(),
        stripeAccountId: typeof stripeAccountId === 'string' && stripeAccountId.trim() ? stripeAccountId.trim() : null,
        stripePublicKey: typeof stripePublicKey === 'string' && stripePublicKey.trim() ? stripePublicKey.trim() : null,
        pixKey: typeof pixKey === 'string' && pixKey.trim() ? pixKey.trim() : null,
        logoUrl: typeof logoUrl === 'string' && logoUrl.trim() ? logoUrl.trim() : null,
        givingOptions: givingOptions.map((option) => ({
          id: option.id.trim(),
          label: option.label.trim(),
          value: option.value.trim(),
          ...(typeof option.pixRegistrationRequired === 'boolean' ? { pixRegistrationRequired: option.pixRegistrationRequired } : {}),
        })),
        paymentMethods: normalizePaymentMethods(paymentMethods),
        theme: {
          primaryColor: theme.primaryColor.trim(),
          ...(typeof theme.secondaryColor === 'string' && theme.secondaryColor.trim() ? { secondaryColor: theme.secondaryColor.trim() } : {}),
          ...(typeof theme.logo === 'string' && theme.logo.trim() ? { logo: theme.logo.trim() } : {}),
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await tenantRef.set(normalizedTenant);

      logger.info(`Tenant created successfully: ${normalizedSlug}`);

      return res.status(201).json({
        success: true,
        tenant: {
          ...normalizedTenant,
          createdAt: null,
          updatedAt: null,
        },
      });
    } catch (error) {
      logger.error('Error in createTenant:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);
