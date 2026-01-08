const admin = require('firebase-admin');

// Hardcoded configs for immediate support while DB is empty
const HARDCODED_TENANTS = {
    'rampchurchdmv': {
        id: 'rampchurchdmv',
        slug: 'rampchurchdmv',
        domain: 'rampchurchdmv.onetapgo.site',
        name: 'The Ramp Church DMV',
        currency: 'usd',
        stripeAccountId: 'acct_1Sgv31FBlE52ezvr', // Add Stripe Connect ID here later
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
            primary: ['pix', 'apple_pay', 'google_pay'],
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
    'onewaychurches': {
        id: 'onewaychurches',
        slug: 'owci',
        domain: 'owci.onetapgo.site',
        name: 'One Way Churches International',
        currency: 'usd',
        stripeAccountId: '', // Add Stripe Connect ID here later
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
        givingOptions: [
            { id: 'offering', label: 'Oferta', value: 'offering', pixRegistrationRequired: false },
            { id: 'tithe', label: 'Dízimo', value: 'tithe', pixRegistrationRequired: true },
            { id: 'pastoral', label: 'Oferta Pastoral', value: 'pastoral', pixRegistrationRequired: true },
            { id: 'building', label: 'Reforma e Construção', value: 'building', pixRegistrationRequired: true },
            { id: 'guest', label: 'Oferta para Convidado', value: 'guest_speaker', pixRegistrationRequired: true },
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
