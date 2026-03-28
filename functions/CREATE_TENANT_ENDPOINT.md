# Create Tenant Endpoint

`POST /createTenant`

Alternativa via rewrite REST:

`POST /api/tenants`

## Body mínimo

```json
{
  "slug": "igreja-exemplo",
  "name": "Igreja Exemplo",
  "currency": "brl",
  "theme": {
    "primaryColor": "#111111"
  },
  "givingOptions": [
    {
      "id": "oferta",
      "label": "Oferta",
      "value": "offering"
    }
  ]
}
```

## Campos opcionais

`domain`, `stripeAccountId`, `stripePublicKey`, `pixKey`, `logoUrl`, `paymentMethods`, `theme.secondaryColor`, `theme.logo`

## Respostas

- `201`: tenant criado
- `400`: payload inválido
- `409`: slug já existe
- `405`: método diferente de `POST`

## Exemplo curl

```bash
curl -X POST https://SEU_DOMINIO/createTenant \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "igreja-exemplo",
    "name": "Igreja Exemplo",
    "currency": "brl",
    "theme": { "primaryColor": "#111111" },
    "givingOptions": [
      { "id": "oferta", "label": "Oferta", "value": "offering" }
    ],
    "paymentMethods": {
      "primary": ["pix", "apple_pay", "google_pay"],
      "secondary": ["card", "link"]
    }
  }'
```
