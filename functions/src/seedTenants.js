const admin = require('firebase-admin');

// Hardcoded configs for immediate support while DB is empty
const HARDCODED_TENANTS = {
    'default': { // Default tenant for onetapgo.site
        id: 'default',
        slug: 'default',
        domain: 'onetapgo.site',
        name: 'OneTapGo (Default)',
        currency: 'usd',
        stripeAccountId: 'acct_XXXXXXXXXXXXXXXX', // Add actual default Stripe Connect ID
        stripePublicKey: 'pk_live_51OcBVaGmR8MQBnbEGPmUcJ6vcnZ38RAdJQSHDftSsvB9YCSAXZcrr8BqQZvBd0OACfibZaI0o1rIAPw3O1bz6T3u00OErTe5Bm', // Placeholder, provide actual default PK
        givingOptions: [
            { id: 'offering', label: 'Offering', value: 'offering' },
        ],
        theme: {
            primaryColor: '#000000',
        },
        paymentMethods: {
            primary: ['card', 'apple_pay', 'google_pay'],
            secondary: ['link', 'amazon_pay', 'crypto']
        }
    },
    'rampchurchdmv': {
        id: 'rampchurchdmv',
        slug: 'rampchurchdmv',
        domain: 'rampchurchdmv.onetapgo.site',
        name: 'The Ramp Church DMV',
        currency: 'usd',
        stripeAccountId: 'acct_1Sgv31FBlE52ezvr',
        stripePublicKey: 'pk_live_51Sgv31FBlE52ezvrVscSh9XuytEKe8m5nzt1CgzZikYfzpNrpkCIHx5zqlgKuktpBUNNThtyvgEXL8Zf4RHMD5TL00zRx9cdH0',
        givingOptions: [
            { id: 'offering', label: 'Offering', value: 'offering' },
            { id: 'tithe', label: 'Tithe', value: 'tithe' },
            { id: 'love_offering', label: 'Love Offering', value: 'love_offering' },
            { id: 'special_seed', label: 'Special Seed', value: 'special_seed' },
        ],
        theme: {
            primaryColor: '#2e296c', // Deep blue 
        },
        paymentMethods: {
            primary: [ 'apple_pay', 'google_pay'],
            secondary: ['card', 'link', 'amazon_pay', 'crypto']
        }
    },
    'syyounger': {
        id: 'syyounger',
        slug: 'syyounger',
        domain: 'syyounger.onetapgo.site',
        name: 'Bishop S. Y. Younger',
        currency: 'usd',
        stripeAccountId: '', // Add Stripe Connect ID here later
        stripePublicKey: 'pk_live_51MUGkkC4EUAkUAjWloSqbh284V6146VsSbRa1Lqch5yOphpbJRlFJwmu6bJVl2r7yopImSIpkBEz9EFTXkZV8DUN00gXojkSmZ', // Placeholder
        givingOptions: [
            { id: 'love_offering', label: 'Love Offering', value: 'love_offering' },
            { id: 'speaking', label: 'Speaking Engagement', value: 'speaking' },
            { id: 'book', label: 'Book Purchase', value: 'book' }
        ],
        theme: {
            primaryColor: '#1a365d', // Deep blue example
        },
        paymentMethods: {
            primary: ['apple_pay', 'google_pay'],
            secondary: ['card', 'link', 'amazon_pay', 'crypto']
        }
    },
    'bishopsyyoungerministries': {
        id: 'bishopsyyoungerministries',
        slug: 'bsyym',
        domain: 'bsyym.onetapgo.site',
        name: 'Bishop S.Y. Younger Ministries',
        currency: 'usd',
        stripeAccountId: '', // Add Stripe Connect ID here later
        stripePublicKey: 'pk_live_51MUGkkC4EUAkUAjWloSqbh284V6146VsSbRa1Lqch5yOphpbJRlFJwmu6bJVl2r7yopImSIpkBEz9EFTXkZV8DUN00gXojkSmZ',
        givingOptions: [
            { id: 'love_offering', label: 'Love Offering', value: 'love_offering' },
            { id: 'merch', label: 'Merch', value: 'merch' },
            { id: 'zelo', label: 'Zelo Project', value: 'zelo' },
            { id: 'other', label: 'Other', value: 'other' }
        ],
        theme: {
            primaryColor: '#1a365d', // Deep blue example
        },
        paymentMethods: {
            primary: ['apple_pay', 'google_pay'],
            secondary: ['card', 'link', 'amazon_pay', 'crypto']
        }
    },
    'cre8onetapgo': { // New tenant for cre8.onetapgo.site
        id: 'cre8onetapgo',
        slug: 'cre8onetapgo',
        domain: 'cre8.onetapgo.site',
        name: 'Cre8 OneTapGo',
        currency: 'usd',
        stripeAccountId: 'acct_XXXXXXXXXXXXXXXX', // Add actual Stripe Connect ID for Cre8
        stripePublicKey: 'pk_live_51OcBVaGmR8MQBnbEGPmUcJ6vcnZ38RAdJQSHDftSsvB9YCSAXZcrr8BqQZvBd0OACfibZaI0o1rIAPw3O1bz6T3u00OErTe5Bm',
        givingOptions: [
            { id: 'offering', label: 'Offering', value: 'offering' },
        ],
        theme: {
            primaryColor: '#FF00FF', // Example color
        },
        paymentMethods: {
            primary: ['card', 'apple_pay', 'google_pay'],
            secondary: ['link', 'amazon_pay', 'crypto']
        }
    },
    'onewaychurches': {
        id: 'onewaychurches',
        slug: 'owci',
        domain: 'owci.onetapgo.site',
        name: 'One Way Churches International',
        currency: 'usd',
        stripeAccountId: '', // Add Stripe Connect ID here later
        stripePublicKey: 'pk_live_51OcBVaGmR8MQBnbEGPmUcJ6vcnZ38RAdJQSHDftSsvB9YCSAXZcrr8BqQZvBd0OACfibZaI0o1rIAPw3O1bz6T3u00OErTe5Bm', // Placeholder
        givingOptions: [
             { id: 'tithe', label: 'Tithe', value: 'tithe' },
            { id: 'offering', label: 'Offering', value: 'offering' },
            { id: 'love_offering', label: 'Love Offering', value: 'love_offering' },
            { id: 'merch', label: ' Ramp DMV Merch', value: 'merch' },
            { id: 'guest', label: 'Guest Speaker', value: 'guest_speaker' },
            { id: 'other', label: 'Other', value: 'other' }
        ],
        theme: {
            primaryColor: '#1a365d', // Deep blue example
        },
        paymentMethods: {
            primary: ['apple_pay', 'google_pay'],
            secondary: ['card', 'link', 'amazon_pay', 'crypto']
        }
    },
    'rampchurchsp': {
        id: 'rampchurchsp',
        slug: 'rampchurchsp',
        name: 'The Ramp Church São Paulo',
        currency: 'brl',
        stripeAccountId: 'acct_1SkWViGa44Ztl1iO', // Add Stripe Connect ID here later
        stripePublicKey: 'pk_live_51OcBVaGmR8MQBnbEGPmUcJ6vcnZ38RAdJQSHDftSsvB9YCSAXZcrr8BqQZvBd0OACfibZaI0o1rIAPw3O1bz6T3u00OErTe5Bm', // Placeholder for BRL PK
        givingOptions: [
            { id: 'offering', label: 'Oferta', value: 'offering', pixRegistrationRequired: false },
            { id: 'tithe', label: 'Dízimo', value: 'tithe', pixRegistrationRequired: true },
            { id: 'pastoral', label: 'Oferta Pastoral', value: 'pastoral', pixRegistrationRequired: true },
            { id: 'building', label: 'Reforma e Construção', value: 'building', pixRegistrationRequired: true },
            { id: 'guest', label: 'Oferta para Convidado', value: 'guest_speaker', pixRegistrationRequired: true },
            { id: 'curso-ia', label: 'Curso IA com Propósito', value: 'ai_course', pixRegistrationRequired: true, minimumAmount: 1, description: 'IA com Propósito: Criando Agentes de IA para trabalho, estudos, negócios e ministério.', formUrl: 'https://forms.gle/XeKFYDhkd767sk317' },
            { id: 'other', label: 'Outro', value: 'other', pixRegistrationRequired: true }
        ],
        theme: {
            primaryColor: '#1a365d', // Deep blue example
        },
        pixKey: '42201173000118', // Example CPF/CNPJ or Key
        paymentMethods: {
            primary: ['pix', 'apple_pay', 'google_pay'],
            secondary: ['card', 'link', 'amazon_pay', 'crypto']
        }
    }
};


const seedTenants = async () => {
    const db = admin.firestore(); // Get Firestore instance from admin SDK
    const tenantsCollection = db.collection("tenants");
    const tenantPromises = Object.values(HARDCODED_TENANTS).map(async (tenant) => {
        // Use the tenant's id as the document ID
        const tenantDocRef = tenantsCollection.doc(tenant.id); // Use .doc() for admin SDK
        try {
            await tenantDocRef.set(tenant); // Use .set() for admin SDK
            console.log(`Successfully seeded tenant: ${tenant.name}`);
        } catch (error) {
            console.error(`Error seeding tenant ${tenant.name}:`, error);
        }
    });

    await Promise.all(tenantPromises);
    console.log("Tenant seeding finished.");
};

module.exports = { seedTenants };
