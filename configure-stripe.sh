#!/bin/bash

# 🔐 Configuração Segura do Stripe para Firebase Functions
# Este script configura as chaves do Stripe de forma segura

echo "🔐 Configuração Segura do Stripe para Firebase Functions"
echo "========================================================"
echo ""

# Verificar se está no diretório correto
if [ ! -f "firebase.json" ]; then
    echo "❌ Execute este script no diretório raiz do projeto Firebase"
    exit 1
fi

echo "📋 Instruções:"
echo "1. Acesse: https://dashboard.stripe.com/test/apikeys"
echo "2. Copie sua SECRET KEY (sk_test_...)"
echo "3. Cole abaixo quando solicitado"
echo ""

# Solicitar a chave secreta
echo "🔑 Digite sua Stripe SECRET KEY (sk_test_...):"
read -s STRIPE_SECRET_KEY

# Validar formato da chave
if [[ ! $STRIPE_SECRET_KEY =~ ^sk_test_ ]]; then
    echo "❌ Chave inválida! Deve começar com 'sk_test_'"
    exit 1
fi

# Configurar no Firebase
echo ""
echo "🚀 Configurando no Firebase..."
firebase functions:config:set stripe.secret_key="$STRIPE_SECRET_KEY"

if [ $? -eq 0 ]; then
    echo "✅ Chave secreta configurada com sucesso!"
    echo ""
    echo "📝 Próximos passos:"
    echo "1. Atualize a chave PUBLISHABLE no index.html"
    echo "2. Execute: firebase deploy --only functions"
    echo "3. Teste os pagamentos!"
    echo ""
    echo "🔒 Sua chave está segura no ambiente Firebase"
else
    echo "❌ Erro ao configurar. Verifique se está logado no Firebase."
fi