const admin = require('firebase-admin');

// Service Account not needed if running with firebase-admin in environment with ADC or via firebase emulators
// But since we want to run this locally against production, we might need a credential or use firebase use wasser-c430a
admin.initializeApp({
    projectId: 'wasser-c430a'
});

const db = admin.firestore();

async function seed() {
    console.log('🌱 Gerando dados iniciais para OneTapGo IoT...');

    // 1. Criar Cliente Default
    const clients = [
        {
            id: 'default',
            name: 'OneTapGo (Default)',
            base_url: 'https://onetapgo.site'
        },
        {
            id: 'the-ramp',
            name: 'The Ramp Church',
            base_url: 'https://theramp.com.br'
        }
    ];

    for (const client of clients) {
        await db.collection('clients').doc(client.id).set({
            name: client.name,
            base_url: client.base_url,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`✅ Cliente [${client.id}] configurado.`);
    }

    // 2. Criar Configurações Iniciais (opcional, dispositivos se auto-registram)
    // Mas vamos garantir que o dashboard tenha algo visual se o usuário abrir agora
    const sampleDevice = "SAMPLE_DEVICE_ID";
    await db.collection('devices').doc(sampleDevice).set({
        label: "Estação de Teste Alpha",
        status: "offline",
        last_seen: admin.firestore.FieldValue.serverTimestamp(),
        config: {
            mode: "RECORDER",
            target_client_slug: "default"
        }
    }, { merge: true });

    console.log('🚀 Seed concluído com sucesso!');
    process.exit(0);
}

seed().catch(err => {
    console.error('❌ Erro no seed:', err);
    process.exit(1);
});
