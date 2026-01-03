const axios = require('axios');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const logger = require("firebase-functions/logger");

class CoraClient {
    constructor(cert, key, clientId, isProduction = false) {
        this.baseUrl = isProduction
            ? 'https://matls-clients.api.cora.com.br'
            : 'https://matls-clients.api.stage.cora.com.br';

        this.authUrl = isProduction
            ? 'https://matls-clients.api.cora.com.br/token'
            : 'https://matls-clients.api.stage.cora.com.br/token'; // Verify auth endpoint

        this.clientId = clientId || 'app-beckerep'; // Default from curl if not provided
        this.cert = cert;
        this.key = key;

        this.agent = new https.Agent({
            cert: this.cert,
            key: this.key,
            // rejectUnauthorized: false // Use only if strictly necessary for debugging
        });

        this.axiosInstance = axios.create({
            baseURL: this.baseUrl,
            httpsAgent: this.agent,
            headers: {
                'Content-Type': 'application/json',
            }
        });

        this.token = null;
        this.tokenExpiry = null;
    }

    async authenticate() {
        // Check if token is valid
        if (this.token && this.tokenExpiry && new Date() < this.tokenExpiry) {
            return this.token;
        }

        try {
            logger.info('Authenticating with Cora...');
            // According to standard OAuth flows for Cora (usually distinct endpoint)
            // If the user didn't provide the auth endpoint, we assume standard /token or similar on the mTLS domain.
            // Based on common Cora docs: POST /token with grant_type=client_credentials provided via mTLS context usually

            const params = new URLSearchParams();
            params.append('grant_type', 'client_credentials');
            params.append('client_id', this.clientId); // Often required in body

            const response = await this.axiosInstance.post('/token', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            this.token = response.data.access_token;
            // Set expiry (usually 3600s). Subtract 60s for safety.
            this.tokenExpiry = new Date(new Date().getTime() + (response.data.expires_in - 60) * 1000);

            logger.info('Cora authentication successful');
            return this.token;
        } catch (error) {
            logger.error('Cora authentication failed', error.response?.data || error.message);
            throw new Error(`Authentication failed: ${error.response?.data?.error_description || error.message}`);
        }
    }

    async createInvoice(amount, customer, serviceName = 'Donation', serviceDesc = 'Donation to The Ramp Church') {
        const token = await this.authenticate();

        const invoiceId = uuidv4();

        const payload = {
            code: invoiceId, // Using UUID as custom code/ID
            customer: {
                name: customer.name,
                email: customer.email,
                document: {
                    identity: customer.document, // CPF or CNPJ
                    type: customer.documentType || 'CPF'
                },
                address: customer.address || {
                    // Default placeholder address if not provided (Cora might require valid address)
                    // Ideally we get this from the user, but for digital goods/donations it might be flexible
                    street: "Not Provided",
                    number: "0",
                    district: "N/A",
                    city: "São Paulo",
                    state: "SP",
                    zip_code: "02840010"
                }
            },
            services: [{
                name: serviceName,
                code: serviceName,
                description: serviceDesc,
                amount: Math.round(amount * 100) // Convert to cents integer
            }],
            payment_terms: {
                due_date: new Date().toISOString().split('T')[0], // Due today for immediate pix
                // fine: {}, interest: {}, discount: {} // Optional
            },
            payment_forms: ["PIX"]
        };

        try {
            logger.info(`Creating invoice for ${amount} BRL...`);
            const response = await this.axiosInstance.post('/v2/invoices', payload, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Idempotency-Key': invoiceId
                }
            });

            logger.info('Cora invoice created successfully', response.data);
            return response.data;
        } catch (error) {
            logger.error('Cora invoice creation failed', error.response?.data || error.message);
            throw error;
        }
    }

    async getInvoice(invoiceId) {
        const token = await this.authenticate();

        try {
            logger.info(`Fetching invoice details for ${invoiceId}...`);
            const response = await this.axiosInstance.get(`/v2/invoices/${invoiceId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            logger.info('Cora invoice fetched successfully');
            return response.data;
        } catch (error) {
            logger.error('Cora invoice fetch failed', error.response?.data || error.message);
            throw error;
        }
    }
}

module.exports = CoraClient;
