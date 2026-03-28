# Tags API

`GET /api/tags`

Endpoint publico para consulta paginada de tags por tenant.

## Objetivo

- listar tags com paginação por cursor estavel
- permitir consulta por um dos campos `tenant`, `slug` ou `client_slug`

## Metodos

- `GET`
- `OPTIONS`

## Query params

- `tenant`: opcional, mas um entre `tenant`, `slug` ou `client_slug` e obrigatorio
- `slug`: opcional
- `client_slug`: opcional
- `limit`: opcional, default `200`, max `500`; acima disso retorna `400`
- `cursor`: opcional, cursor opaco retornado pela pagina anterior

Se mais de um filtro for enviado, a precedencia e:

1. `tenant`
2. `slug`
3. `client_slug`

## Exemplos

### Buscar por tenant

```bash
curl "https://onetapgo.site/api/tags?tenant=rampchurchsp"
```

### Buscar por slug com limite customizado

```bash
curl "https://onetapgo.site/api/tags?slug=rampchurchsp&limit=50"
```

### Buscar por client_slug com cursor

```bash
curl "https://onetapgo.site/api/tags?client_slug=rampchurchsp&limit=200&cursor=ZXhhbXBsZTE"
```

## Resposta de sucesso

```json
{
  "success": true,
  "filters": {
    "field": "tenant",
    "value": "rampchurchsp",
    "limit": 200
  },
  "count": 2,
  "tags": [
    {
      "id": "0288e7d4",
      "uid": "0288e7d4",
      "tenant": "rampchurchsp",
      "slug": null,
      "client_slug": "rampchurchsp",
      "status": "active",
      "redirect_url": "https://example.com",
      "redirect_override": null,
      "target_url": null,
      "url": null,
      "redirectUrl": null,
      "scan_count": 3,
      "provisioned_by": "device-123",
      "provisioned_at": "2026-03-28T17:00:00.000Z",
      "last_scan_at": "2026-03-28T17:10:00.000Z",
      "updated_at": "2026-03-28T17:11:00.000Z",
      "updatedAt": null,
      "createdAt": null
    }
  ],
  "pagination": {
    "nextCursor": "MDI4OGU3ZDQ",
    "hasMore": false
  }
}
```

## Erros

### Filtro ausente

```json
{
  "success": false,
  "error": "one of tenant, slug, or client_slug is required"
}
```

### Limit invalido

```json
{
  "success": false,
  "error": "limit must be a positive integer"
}
```

O mesmo erro e retornado quando `limit` for maior que `500`.

### Cursor invalido

```json
{
  "success": false,
  "error": "cursor is invalid"
}
```

## Observacoes

- a ordenacao e por `doc.id` ascendente
- o cursor representa o ultimo `doc.id` da pagina anterior, codificado em base64url
- `hasMore` indica se existe pagina seguinte
- `nextCursor` so vem quando `hasMore` for `true`
- a consulta usa os indices simples padrao do Firestore; nao precisa de indice composto especifico para `tags`

## KPIs

`GET /api/tags/kpis`

Endpoint publico para consulta agregada de KPIs de tags por tenant.

### Query params

- `tenant`: opcional, mas um entre `tenant`, `slug` ou `client_slug` e obrigatorio
- `slug`: opcional
- `client_slug`: opcional

Se mais de um filtro for enviado, a precedencia e:

1. `tenant`
2. `slug`
3. `client_slug`

### Exemplo

```bash
curl "https://onetapgo.site/api/tags/kpis?tenant=rampchurchsp"
```

### Resposta de sucesso

```json
{
  "success": true,
  "filters": {
    "field": "tenant",
    "value": "rampchurchsp"
  },
  "kpis": {
    "total_tags": 34,
    "active_tags": 2,
    "inactive_tags": 32,
    "tags_with_scans": 18,
    "tags_without_scans": 16,
    "tags_with_redirect": 34,
    "tags_without_redirect": 0,
    "total_scans": 5595,
    "average_scans_per_tag": 164.56,
    "latest_scan_at": "2026-03-28T22:07:54.120Z",
    "latest_updated_at": "2026-03-28T22:07:54.120Z",
    "active_urls": [
      {
        "url": "https://onetapgo.site/rampchurchsp",
        "count": 33
      },
      {
        "url": "https://onetapgo.com.br",
        "count": 1
      }
    ],
    "status_breakdown": {
      "active": 2,
      "unknown": 32
    }
  }
}
```

### Erro de filtro ausente

```json
{
  "success": false,
  "error": "one of tenant, slug, or client_slug is required"
}
```

### Observacoes

- `inactive_tags` agrega qualquer status diferente de `active`
- `tags_with_redirect` considera `redirect_url`, `redirect_override`, `target_url`, `url` e `redirectUrl`
- `latest_updated_at` usa `updated_at`, `updatedAt` e, como fallback, `createdAt`
- `active_urls` lista as URLs atualmente configuradas nas tags e a quantidade de ocorrencias

## Atualizacao Por IDs

`POST /api/tags/update-by-ids`

Endpoint administrativo para atualizar a URL de tags especificas por lista de IDs.

### Body

```json
{
  "ids": ["tag-1", "tag-2"],
  "newUrl": "https://example.com/nova-url",
  "field": "redirect_url"
}
```

### Campos

- `ids`: obrigatorio. Array nao vazio com IDs das tags
- `newUrl`: obrigatorio. Tambem aceita `url` ou `redirectUrl`
- `field`: opcional. Aceita `redirect_url`, `redirect_override`, `target_url`, `url` ou `redirectUrl`

### Exemplo

```bash
curl -X POST "https://onetapgo.site/api/tags/update-by-ids" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["159f7cc7", "194def19"],
    "newUrl": "https://example.com/nova-url",
    "field": "redirect_url"
  }'
```

### Resposta de sucesso

```json
{
  "success": true,
  "ids": ["159f7cc7", "194def19"],
  "missingIds": [],
  "newUrl": "https://example.com/nova-url",
  "field": "redirect_url",
  "matchedTags": 2,
  "updatedTags": 2,
  "auditId": "abc123"
}
```

### Resposta com IDs faltantes

```json
{
  "success": true,
  "ids": ["159f7cc7", "tag-inexistente"],
  "missingIds": ["tag-inexistente"],
  "newUrl": "https://example.com/nova-url",
  "field": "redirect_url",
  "matchedTags": 1,
  "updatedTags": 1,
  "auditId": "abc123"
}
```

### Erros

```json
{
  "error": "ids must be a non-empty array"
}
```

```json
{
  "error": "No tags found for provided ids"
}
```

### Observacoes

- `missingIds` mostra quais IDs enviados nao existem na colecao `tags`
- o endpoint grava auditoria em `tag_url_audits`
- atualiza tambem `updated_at` e `updatedAt`
