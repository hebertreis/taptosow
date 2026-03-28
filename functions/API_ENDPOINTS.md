# APIs Disponiveis

Este documento consolida as APIs encontradas em [firebase.json](/Users/hebertreis/taptosow/firebase.json) e [functions/index.js](/Users/hebertreis/taptosow/functions/index.js).

## Visao geral

Existem dois grupos de endpoints:

- rotas publicas expostas por Firebase Hosting rewrites
- Cloud Functions `onRequest` existentes no codigo, mas sem rewrite publico definido neste repositório

## Rotas publicas via Hosting

### `POST /createPaymentIntent`

Function: `createPaymentIntent`

Objetivo:
- cria um `PaymentIntent` no Stripe Connect

Metodos:
- `POST`
- `OPTIONS`

Body:

```json
{
  "amount": 100,
  "currency": "brl",
  "stripeAccountId": "acct_xxx",
  "metadata": {
    "tenant": "igreja-exemplo"
  },
  "customer": {
    "name": "Nome da Pessoa",
    "email": "pessoa@exemplo.com"
  },
  "paymentMethodTypes": ["card", "apple_pay", "google_pay"]
}
```

Campos relevantes:
- `amount`: obrigatorio, numero maior que zero
- `currency`: opcional, default `usd`
- `stripeAccountId`: obrigatorio, pode vir no body ou em `metadata.stripeAccountId`
- `metadata`: opcional
- `customer`: opcional

Resposta de sucesso:

```json
{
  "clientSecret": "pi_xxx_secret_xxx"
}
```

Status:
- `200` sucesso
- `400` valor invalido, moeda nao suportada ou `stripeAccountId` ausente
- `405` metodo nao permitido
- `500` erro interno ou secret ausente

Observacoes:
- a chave Stripe e selecionada com base em `Origin` ou `Referer`
- `automatic_payment_methods` esta habilitado

### `POST /createCoraPixCharge`

Function: `createCoraPixCharge`

Objetivo:
- cria cobranca PIX via Cora

Metodos:
- `POST`
- `OPTIONS`

Body:

```json
{
  "amount": 100,
  "customer": {
    "name": "Nome da Pessoa",
    "document": "00000000000"
  },
  "serviceName": "Doacao",
  "serviceDesc": "Oferta"
}
```

Resposta de sucesso:

```json
{
  "success": true,
  "invoiceId": "inv_xxx",
  "pixCode": "000201...",
  "fullResponse": {}
}
```

Status:
- `200` sucesso
- `405` metodo nao permitido
- `500` falha ao criar cobranca

### `POST /checkCoraPixStatus`

Function: `checkCoraPixStatus`

Objetivo:
- consulta status de uma cobranca PIX da Cora

Metodos:
- `POST`
- `OPTIONS`

Body:

```json
{
  "invoiceId": "inv_xxx"
}
```

Resposta de sucesso:

```json
{
  "success": true,
  "status": "OPEN",
  "invoice": {}
}
```

Status:
- `200` sucesso
- `400` `invoiceId` ausente
- `405` metodo nao permitido
- `500` falha na consulta

### `GET /getStripePublicKey`

Function: `getStripePublicKey`

Objetivo:
- retorna a chave publica Stripe do tenant inferido por dominio ou URI

Metodos:
- `GET`
- `OPTIONS`

Resposta de sucesso:

```json
{
  "publicKey": "pk_live_xxx"
}
```

Status:
- `200` sucesso
- `405` metodo nao permitido
- `500` falha ao localizar tenant ou chave publica

Observacoes:
- a deteccao do tenant depende de `Origin`, `Referer` e `req.path`
- se o tenant nao for encontrado, tenta usar `default`

### `GET|POST /getTenantBySlug`

Function: `getTenantBySlug`

Objetivo:
- retorna configuracao de um tenant por `slug`

Metodos:
- `GET`
- `POST`
- `OPTIONS`

Entrada:
- query param `slug`
- ou body `{ "slug": "tenant-id" }`

Resposta de sucesso:

```json
{
  "success": true,
  "tenant": {
    "slug": "igreja-exemplo"
  }
}
```

Status:
- `200` sucesso
- `400` `slug` ausente
- `404` tenant nao encontrado
- `500` erro interno

### `POST /createTenant`

Alias de:
- `POST /api/tenants`

Function: `createTenant` -> `upsertTenant`

Objetivo:
- cria ou atualiza tenant

Metodos:
- `POST`
- `OPTIONS`

Body minimo:

```json
{
  "slug": "igreja-exemplo",
  "name": "Igreja Exemplo",
  "currency": "brl",
  "fallbackUrl": "https://onetapgo.site/igreja-exemplo",
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

Campos opcionais:
- `domain`
- `sectors`
- `stripeAccountId`
- `stripePublicKey`
- `pixKey`
- `logoUrl`
- `paymentMethods`
- `theme.secondaryColor`
- `theme.logo`

Resposta de sucesso:

```json
{
  "success": true,
  "operation": "created",
  "tenant": {},
  "sectors": []
}
```

Status:
- `200` tenant atualizado
- `201` tenant criado
- `400` payload invalido
- `405` metodo nao permitido
- `500` erro interno

### `POST /api/tenant-tags/update-url`

Function: `updateTenantTagUrl`

Objetivo:
- atualiza em lote a URL de redirecionamento das tags de um tenant especifico
- cria um documento de auditoria em `tag_url_audits`

Metodos:
- `POST`
- `OPTIONS`

Body:

```json
{
  "tenant": "igreja-exemplo",
  "newUrl": "https://example.com/nova-url",
  "field": "redirect_url"
}
```

Campos relevantes:
- `tenant`: obrigatorio. Tambem aceita `slug`
- `newUrl`: obrigatorio. Tambem aceita `url` ou `redirectUrl`
- `field`: opcional. Aceita `redirect_url`, `redirect_override`, `target_url`, `url` ou `redirectUrl`. Default `redirect_url`

Resposta de sucesso:

```json
{
  "success": true,
  "tenant": "igreja-exemplo",
  "newUrl": "https://example.com/nova-url",
  "field": "redirect_url",
  "matchedTags": 120,
  "updatedTags": 120,
  "auditId": "abc123"
}
```

Status:
- `200` sucesso
- `400` `tenant`, `newUrl` ou `field` invalidos
- `404` nenhuma tag encontrada para o tenant
- `405` metodo nao permitido
- `500` erro interno

Observacoes:
- a busca considera tags com tenant salvo em `tenant`, `slug` ou `client_slug`
- o endpoint grava auditoria com tenant, URL nova, campo alterado, contagem e amostras das tags afetadas
- atualiza tambem `updated_at` e `updatedAt` nas tags alteradas

### `POST /api/tags/update-by-ids`

Function: `updateTagUrlByIds`

Objetivo:
- atualiza em lote a URL de redirecionamento de tags especificas por ID
- cria um documento de auditoria em `tag_url_audits`

Metodos:
- `POST`
- `OPTIONS`

Body:

```json
{
  "ids": ["tag-1", "tag-2"],
  "newUrl": "https://example.com/nova-url",
  "field": "redirect_url"
}
```

Campos relevantes:
- `ids`: obrigatorio. Array nao vazio com IDs de tags
- `newUrl`: obrigatorio. Tambem aceita `url` ou `redirectUrl`
- `field`: opcional. Aceita `redirect_url`, `redirect_override`, `target_url`, `url` ou `redirectUrl`. Default `redirect_url`

Resposta de sucesso:

```json
{
  "success": true,
  "ids": ["tag-1", "tag-2"],
  "missingIds": [],
  "newUrl": "https://example.com/nova-url",
  "field": "redirect_url",
  "matchedTags": 2,
  "updatedTags": 2,
  "auditId": "abc123"
}
```

Status:
- `200` sucesso
- `400` `ids`, `newUrl` ou `field` invalidos
- `404` nenhuma tag encontrada para os IDs enviados
- `405` metodo nao permitido
- `500` erro interno

Observacoes:
- `missingIds` retorna os IDs solicitados que nao foram encontrados
- o endpoint grava auditoria com IDs solicitados, IDs faltantes, URL nova, campo alterado e amostras das tags afetadas
- atualiza tambem `updated_at` e `updatedAt` nas tags alteradas

### `GET /api/tags`

Function: `listTags`

Objetivo:
- listar tags com paginacao por cursor

Metodos:
- `GET`
- `OPTIONS`

Query params:
- um entre `tenant`, `slug` ou `client_slug` e obrigatorio
- `limit`: opcional, default `200`, max `500`; acima disso retorna `400`
- `cursor`: opcional, cursor opaco da pagina anterior

Resposta de sucesso:

```json
{
  "success": true,
  "filters": {
    "field": "tenant",
    "value": "igreja-exemplo",
    "limit": 200
  },
  "count": 1,
  "tags": [
    {
      "id": "abc123",
      "tenant": "igreja-exemplo",
      "slug": "igreja-exemplo",
      "client_slug": "igreja-exemplo"
    }
  ],
  "pagination": {
    "nextCursor": null,
    "hasMore": false
  }
}
```

Status:
- `200` sucesso
- `400` filtro ausente, `limit` invalido ou `cursor` invalido
- `405` metodo nao permitido
- `500` erro interno

Observacoes:
- se mais de um filtro for enviado, vale a precedencia `tenant` > `slug` > `client_slug`
- a ordenacao e por `doc.id` ascendente
- `nextCursor` so vem quando existir proxima pagina
- a query usa os indices simples padrao do Firestore; nao exige indice composto novo para `tags`

Documentacao detalhada:
- [TAGS_API.md](/Users/hebertreis/taptosow/functions/TAGS_API.md)

### `GET /api/tags/kpis`

Function: `getTagKpis`

Objetivo:
- agregar KPIs de tags por tenant

Metodos:
- `GET`
- `OPTIONS`

Query params:
- um entre `tenant`, `slug` ou `client_slug` e obrigatorio

Resposta de sucesso:

```json
{
  "success": true,
  "filters": {
    "field": "tenant",
    "value": "igreja-exemplo"
  },
  "kpis": {
    "total_tags": 12,
    "active_tags": 10,
    "inactive_tags": 2,
    "tags_with_scans": 8,
    "tags_without_scans": 4,
    "tags_with_redirect": 12,
    "tags_without_redirect": 0,
    "total_scans": 149,
    "average_scans_per_tag": 12.42,
    "latest_scan_at": "2026-03-28T17:10:00.000Z",
    "latest_updated_at": "2026-03-28T17:11:00.000Z",
    "active_urls": [
      {
        "url": "https://example.com",
        "count": 8
      },
      {
        "url": "https://fallback.example.com",
        "count": 4
      }
    ],
    "status_breakdown": {
      "active": 10,
      "inactive": 2
    }
  }
}
```

Status:
- `200` sucesso
- `400` filtro ausente
- `405` metodo nao permitido
- `500` erro interno

Observacoes:
- se mais de um filtro for enviado, vale a precedencia `tenant` > `slug` > `client_slug`
- `inactive_tags` agrega qualquer status diferente de `active`, inclusive `unknown`
- `tags_with_redirect` considera `redirect_url`, `redirect_override`, `target_url`, `url` e `redirectUrl`
- `active_urls` lista as URLs atualmente configuradas nas tags e a quantidade de ocorrencias

### `GET /api/seed`

Function: `iotSeed`

Objetivo:
- semeia registros iniciais da colecao `clients`

Metodos:
- sem validacao explicita de metodo no codigo

Resposta:
- texto simples: `Seed OK! Clientes criados.`

Status:
- `200` sucesso
- `500` erro interno

Observacoes:
- endpoint administrativo; atualmente sem autenticacao

### `GET /api/device/sync`

Function: `iotRouter`

Objetivo:
- sincroniza dispositivo IoT e retorna configuracao

Metodos:
- normalmente `GET`

Query params:
- `deviceId`: obrigatorio

Comportamento:
- atualiza `last_seen` e `status`
- se o dispositivo nao existir, cria configuracao default

Resposta de sucesso:

```json
{
  "mode": "RECORDER",
  "target_client_slug": "default"
}
```

Status:
- `200` sucesso
- `400` `deviceId` ausente
- `500` erro interno

### `POST /api/device/event`

Function: `iotRouter`

Objetivo:
- recebe feedback de dispositivo IoT e opcionalmente provisiona tags

Body:

```json
{
  "device_id": "device-1",
  "uid": "TAG123",
  "action": "write",
  "success": true,
  "mode_executed": "RECORDER"
}
```

Campos obrigatorios:
- `device_id`
- `uid`

Resposta de sucesso:

```json
{
  "success": true
}
```

Status:
- `200` sucesso
- `400` payload ausente ou incompleto
- `500` erro interno

### `ANY /api/webhook-pix/{cnpj}`

Function: `proxyPixWebhook`

Objetivo:
- faz proxy de webhook PIX para `https://giving.onetapgo.site`

Metodos:
- aceita qualquer metodo HTTP

Path param:
- `{cnpj}`: obrigatorio, 14 digitos

Comportamento:
- repassa headers e body para o upstream
- replica status e resposta do upstream
- publica evento assíncrono no Redis quando configurado

Status:
- `400` path invalido
- `502` erro ao contactar upstream
- ou o mesmo status retornado pelo upstream

### `GET|POST /api/form-submissions`

Function: `saveFormSubmission`

Objetivo:
- grava e consulta submissao de formulario em `form_submissions`

Metodos:
- `GET`
- `POST`
- `OPTIONS`

#### `POST` salvar submissao

Body:

```json
{
  "churchSlug": "igreja-exemplo",
  "churchName": "Igreja Exemplo",
  "formType": "member-registration",
  "formData": {
    "name": "Maria",
    "email": "maria@exemplo.com"
  },
  "destination": "crm",
  "sourcePath": "/igreja-exemplo"
}
```

Campos obrigatorios:
- `churchSlug`
- `formType`
- `formData` objeto

Resposta de sucesso:

```json
{
  "success": true,
  "submissionId": "abc123"
}
```

Status:
- `200` sucesso
- `400` payload invalido
- `405` metodo nao permitido
- `500` erro interno

#### `GET` consultar submissões

Query params:
- `tenant`: obrigatorio
- `formType`: opcional
- `name`: opcional
- `email`: opcional
- `phone`: opcional
- `document`: opcional
- `q`: opcional, busca geral
- `limit`: opcional, default `20`, max `100`

Exemplo:

```bash
curl "https://onetapgo.site/api/form-submissions?tenant=igreja-exemplo&email=maria@exemplo.com&limit=10"
```

Resposta de sucesso:

```json
{
  "success": true,
  "filters": {
    "tenant": "igreja-exemplo",
    "email": "maria@exemplo.com",
    "limit": 10
  },
  "count": 1,
  "submissions": [
    {
      "id": "abc123",
      "tenant": "igreja-exemplo",
      "churchSlug": "igreja-exemplo",
      "churchName": "Igreja Exemplo",
      "formType": "member-registration",
      "formData": {
        "name": "Maria",
        "email": "maria@exemplo.com"
      },
      "destination": "crm",
      "sourcePath": "/igreja-exemplo",
      "referer": "https://onetapgo.site/igreja-exemplo",
      "origin": "https://onetapgo.site",
      "createdAt": "2026-03-28T14:00:00.000Z",
      "updatedAt": "2026-03-28T14:00:00.000Z"
    }
  ]
}
```

Status:
- `200` sucesso
- `400` `tenant` ausente
- `405` metodo nao permitido
- `500` erro interno

Documentacao detalhada:
- [FORM_SUBMISSIONS_API.md](/Users/hebertreis/taptosow/functions/FORM_SUBMISSIONS_API.md)

### `GET /a`

Rewrite configurado para:
- `redirectAuto`

Estado atual:
- nao existe `exports.redirectAuto` em [functions/index.js](/Users/hebertreis/taptosow/functions/index.js)

Impacto:
- a documentacao desta rota fica inconsistente com o codigo atual
- a logica equivalente parece ter sido absorvida por `iotRouter`

### `GET /a/{id}`

Rewrite:
- `/a/**` -> `iotRouter`

Objetivo:
- redireciona por tag

Comportamento:
- busca `tags/{id}`
- incrementa contadores de scan
- tenta `redirect_url`, `redirect_override`, `target_url`, `url` ou `redirectUrl`
- se nao encontrar, usa fallback em `site_config/fallback`
- responde com HTML intersticial que redireciona em seguida

Status:
- `200` HTML de redirecionamento
- `500` erro interno

### `GET /go/{slug}/{uid}`

Rewrite:
- `/go/**` -> `iotRouter`

Objetivo:
- redirecionamento por cliente e tag

Comportamento:
- busca `tags/{uid}` e `clients/{slug}`
- usa `redirect_override` da tag ou `base_url` do client
- responde com HTML intersticial que redireciona em seguida

Status:
- `200` HTML de redirecionamento
- `302` fallback local em caso de path invalido
- `500` erro interno

## Functions existentes sem rewrite publico no `firebase.json`

Estas APIs existem no codigo, mas nao estao expostas por uma rota amigavel de Hosting neste repositório. Elas ainda podem ser acessadas pela URL padrao de Cloud Functions, dependendo do ambiente.

### `logEvent`

Objetivo:
- grava eventos genericos em `events`
- para tipos especificos, atualiza `payments` ou `users`

Metodos:
- `POST`
- `OPTIONS`

Body:

```json
{
  "eventType": "payment_intent_success",
  "data": {
    "stripePaymentIntentId": "pi_xxx"
  }
}
```

Status:
- `200` sucesso
- `400` `eventType` ou `data` ausentes
- `405` metodo nao permitido
- `500` erro interno

### `verifyApplePayDomain`

Objetivo:
- registra e verifica dominio de Apple Pay no Stripe

Metodos:
- `POST`
- `OPTIONS`

Body:

```json
{
  "domain": "example.com",
  "stripeAccountId": "acct_xxx"
}
```

Status:
- `200` sucesso
- `500` falha de verificacao

Observacoes:
- o codigo nao bloqueia explicitamente outros metodos alem de `OPTIONS`
- se `domain` e `stripeAccountId` nao forem enviados, usa defaults hardcoded

### `seedTenantsFunction`

Objetivo:
- executa `seedTenants()`

Metodos:
- `GET`
- `POST`
- `OPTIONS`

Status:
- `200` sucesso
- `500` erro interno

Observacoes:
- endpoint administrativo; atualmente sem autenticacao

## Resumo rapido

Para integrações externas, as rotas hoje mais relevantes sao:

- `POST /api/form-submissions`
- `GET /api/form-submissions`
- `GET|POST /getTenantBySlug`
- `POST /api/tenants`
- `POST /api/tenant-tags/update-url`
- `POST /api/tags/update-by-ids`
- `GET /api/tags`
- `GET /api/tags/kpis`
- `POST /createPaymentIntent`
- `POST /createCoraPixCharge`
- `POST /checkCoraPixStatus`

## Pendencias encontradas

- o rewrite `/a` aponta para `redirectAuto`, mas essa export nao existe no arquivo principal atual
- `logEvent`, `verifyApplePayDomain` e `seedTenantsFunction` existem como functions, mas nao possuem rewrite publico em [firebase.json](/Users/hebertreis/taptosow/firebase.json)
- endpoints administrativos sensiveis estao sem autenticacao explicita
