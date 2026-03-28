# Upsert Tenant Endpoint

`POST /createTenant`

Alternativa via rewrite REST:

`POST /api/tenants`

URL pública de chamada:

- `https://onetapgo.site/createTenant`
- `https://onetapgo.site/api/tenants`

Comportamento:

- se o `slug` nao existir, cria
- se o `slug` ja existir, atualiza
- se `sectors` nao for enviado, so cria automaticamente `sectors/default` quando a subcolecao `sectors` ainda nao existir
- se `sectors` for enviado, faz upsert por documento da subcolecao: atualiza os existentes e cria apenas os que ainda nao existirem

## Body mínimo

```json
{
  "slug": "igreja-exemplo",
  "name": "Igreja Exemplo",
  "currency": "brl",
  "fallbackUrl": "https://onetapgo.site/igreja-exemplo",
  "sectors": [
    {
      "internal": "default",
      "name": "Padrao"
    }
  ],
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

## Campo obrigatório adicional

`fallbackUrl`

## Campos opcionais

`domain`, `stripeAccountId`, `stripePublicKey`, `pixKey`, `logoUrl`, `paymentMethods`, `theme.secondaryColor`, `theme.logo`

## Sectors

`sectors` representa a subcolecao `tenants/{tenantId}/sectors`.

Cada item deve seguir este formato:

```json
{
  "internal": "default",
  "name": "Padrao"
}
```

Se `sectors` nao for enviado, a API cria automaticamente apenas este documento quando ainda nao existir nenhum sector:

```json
{
  "internal": "default",
  "name": "Padrao"
}
```

## Exemplo real baseado em `rampchurchsp`

```json
{
  "slug": "rampchurchsp-novo",
  "name": "The Ramp Church São Paulo",
  "currency": "brl",
  "stripeAccountId": "acct_1SkWViGa44Ztl1iO",
  "stripePublicKey": "pk_live_51OcBVaGmR8MQBnbEGPmUcJ6vcnZ38RAdJQSHDftSsvB9YCSAXZcrr8BqQZvBd0OACfibZaI0o1rIAPw3O1bz6T3u00OErTe5Bm",
  "pixKey": "42201173000118",
  "fallbackUrl": "https://onetapgo.site/rampchurchsp",
  "sectors": [
    {
      "internal": "default",
      "name": "Padrao"
    }
  ],
  "theme": {
    "primaryColor": "#1a365d"
  },
  "givingOptions": [
    {
      "id": "offering",
      "label": "Oferta",
      "value": "offering",
      "pixRegistrationRequired": false
    },
    {
      "id": "tithe",
      "label": "Dízimo",
      "value": "tithe",
      "pixRegistrationRequired": true
    },
    {
      "id": "pastoral",
      "label": "Oferta Pastoral",
      "value": "pastoral",
      "pixRegistrationRequired": true
    }
  ],
  "paymentMethods": {
    "primary": ["pix", "apple_pay", "google_pay"],
    "secondary": ["card", "link", "amazon_pay", "crypto"]
  }
}
```

## Respostas

- `200`: tenant atualizado
- `201`: tenant criado
- `400`: payload inválido
- `405`: método diferente de `POST`

## Exemplo curl

```bash
curl -X POST https://onetapgo.site/createTenant \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "rampchurchsp-novo",
    "name": "The Ramp Church São Paulo",
    "currency": "brl",
    "stripeAccountId": "acct_1SkWViGa44Ztl1iO",
    "stripePublicKey": "pk_live_51OcBVaGmR8MQBnbEGPmUcJ6vcnZ38RAdJQSHDftSsvB9YCSAXZcrr8BqQZvBd0OACfibZaI0o1rIAPw3O1bz6T3u00OErTe5Bm",
    "pixKey": "42201173000118",
    "fallbackUrl": "https://onetapgo.site/rampchurchsp",
    "sectors": [
      { "internal": "default", "name": "Padrao" }
    ],
    "theme": { "primaryColor": "#1a365d" },
    "givingOptions": [
      { "id": "offering", "label": "Oferta", "value": "offering", "pixRegistrationRequired": false },
      { "id": "tithe", "label": "Dízimo", "value": "tithe", "pixRegistrationRequired": true }
    ],
    "paymentMethods": {
      "primary": ["pix", "apple_pay", "google_pay"],
      "secondary": ["card", "link", "amazon_pay", "crypto"]
    }
  }'
```
