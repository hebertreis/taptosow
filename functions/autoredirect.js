const admin = require('firebase-admin');
admin.initializeApp({ projectId: '<projectId>' });
(async () => {
  await admin.firestore().doc('site_config/auto_redirect').set({ url: 'https://exemplo.com', type: 302 });
  console.log('ok');
  process.exit(0);
})();