# Tags API

`GET /api/tags`

Endpoint publico para consulta paginada de tags por tenant.

## Objetivo

- listar tags com paginação por cursor estavel
- permitir consulta por `tenant`

## Metodos

- `GET`
- `OPTIONS`

## Query params

- `tenant`: obrigatorio
- `sector`: opcional. Filtra tags que possuem esse setor no documento da tag
- `limit`: opcional, default `200`, max `500`; acima disso retorna `400`
- `cursor`: opcional, cursor opaco retornado pela pagina anterior

## Exemplos

### Buscar por tenant

```bash
curl "https://onetapgo.site/api/tags?tenant=rampchurchsp"
```

### Buscar por tenant e setor

```bash
curl "https://onetapgo.site/api/tags?tenant=rampchurchsp&sector=visitantes"
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
      "tenantId": "rampchurchsp",
      "sector": "visitantes",
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
  "error": "tenant is required"
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

- `tenant`: obrigatorio
- `sector`: opcional. Quando enviado, agrega apenas tags daquele setor

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
  "error": "tenant is required"
}
```

### Observacoes

- `inactive_tags` agrega qualquer status diferente de `active`
- `tags_with_redirect` considera `redirect_url`, `redirect_override`, `target_url`, `url` e `redirectUrl`
- `latest_updated_at` usa `updated_at`, `updatedAt` e, como fallback, `createdAt`
- `active_urls` lista as URLs atualmente configuradas nas tags e a quantidade de ocorrencias
- tags listadas em `site_config/reporting_settings.ignoredTagIds` sao excluidas dos KPIs e ignoradas no PostHog

## Gestao De Tags Por Setor

As tags gravadas pelo painel podem ter `sector` no documento `tags/{tagId}`.
Quando uma tag com setor e lida em `https://onetapgo.site/a/{tagId}`, a Function consulta `tenants/{tenant}/sectors/{sector}` e escolhe o destino nesta ordem:

1. excecao individual explicita (`redirect_override`)
2. URL fixa do setor
3. URL legada direta da tag (`redirect_url`, `target_url`, `url` ou `redirectUrl`)
4. fallback do cliente ou fallback global

Isso permite trocar a URL de um setor inteiro sem selecionar uma tag por vez.
Uma tag so deixa de acompanhar o setor quando `redirect_override` estiver preenchido.

### `GET /api/tag-sectors`

Lista setores de um tenant, a URL ativa no momento e quantas tags estao ligadas a cada setor.

```bash
curl "https://onetapgo.site/api/tag-sectors?tenant=rampchurchsp"
```

Para consultar um setor especifico:

```bash
curl "https://onetapgo.site/api/tag-sectors?tenant=rampchurchsp&sector=visitantes"
```

Resposta:

```json
{
  "success": true,
  "tenant": "rampchurchsp",
  "count": 1,
  "sectors": [
    {
      "id": "visitantes",
      "internal": "visitantes",
      "name": "Visitantes",
      "redirect_url": "https://example.com/visitantes",
      "active": true,
      "schedules": [],
      "activeDestinationUrl": "https://example.com/visitantes",
      "activeRedirectSource": "sector_redirect_url",
      "activeScheduleId": null,
      "tagCount": 25
    }
  ]
}
```

### `POST /api/tag-sectors/update-url`

Cria ou atualiza a URL e a agenda do setor em `tenants/{tenant}/sectors/{sector}`.
O endpoint nao precisa atualizar as tags individualmente; qualquer tag com esse `sector` passa a seguir o destino do setor no proximo acesso.

Body com URL fixa:

```json
{
  "tenant": "rampchurchsp",
  "sector": "visitantes",
  "name": "Visitantes",
  "newUrl": "https://example.com/visitantes"
}
```

Exemplo:

```bash
curl -X POST "https://onetapgo.site/api/tag-sectors/update-url" \
  -H "Content-Type: application/json" \
  -d '{
    "tenant": "rampchurchsp",
    "sector": "visitantes",
    "newUrl": "https://example.com/visitantes"
  }'
```

### Agenda de mudanca de URL

O campo `schedules` aceita quantos cadastros forem necessarios.
A zona de horario usada na avaliacao e `America/Sao_Paulo`.

Agenda semanal:

```json
{
  "tenant": "rampchurchsp",
  "sector": "auditorio",
  "newUrl": "https://example.com/visitantes",
  "schedules": [
    {
      "id": "domingo_visitantes_0900",
      "daysOfWeek": [0],
      "startTime": "09:00",
      "url": "https://example.com/visitantes"
    },
    {
      "id": "domingo_oferta_1000",
      "daysOfWeek": [0],
      "startTime": "10:00",
      "url": "https://give.onetapgo.site/rampchurchsp"
    }
  ]
}
```

Agenda de data especifica, com prioridade maior que a semanal:

```json
{
  "tenant": "rampchurchsp",
  "sector": "auditorio",
  "schedules": [
    {
      "id": "natal_2026",
      "date": "2026-12-25",
      "startTime": "08:00",
      "url": "https://example.com/natal"
    }
  ]
}
```

Regras:

- `daysOfWeek` usa `0` para domingo, `1` para segunda, ate `6` para sabado; tambem aceita nomes como `domingo`, `monday` ou `sexta`
- `date` usa `YYYY-MM-DD`
- `startTime` usa `HH:mm`; se omitido, considera `00:00`
- se duas agendas do mesmo tipo baterem, ganha a de maior `priority`; em empate, ganha o maior `startTime`; em novo empate, ganha a ultima da lista
- `endTime` e opcional; se enviado, a agenda so vale ate esse horario
- uma agenda com `active: false` ou `enabled: false` e ignorada

## Atualizacao Por IDs

Para criar uma excecao individual, envie `field: "redirect_override"`. Para fazer a tag
voltar a acompanhar o setor, envie `clear: true` com esse mesmo campo.

## Remover Tags De Um Setor

`POST /api/tags/remove-sector` recebe `tenant` e `ids`. A operacao remove o campo
`sector` das tags pertencentes ao tenant, informa `missingIds` e registra auditoria.

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

## Configuracao De Relatorios

`GET|POST /api/tags/reporting-settings`

Endpoint para gerenciar as tags ignoradas em relatorios.

As IDs configuradas aqui:

- nao entram nos KPIs de `GET /api/tags/kpis`
- nao enviam eventos de redirect para o PostHog

### `GET` consultar configuracao

```bash
curl "https://onetapgo.site/api/tags/reporting-settings"
```

Resposta:

```json
{
  "success": true,
  "reporting": {
    "ignoredTagIds": ["159f7cc7", "194def19"],
    "ignoredTagsCount": 2,
    "firestoreDocumentPath": "site_config/reporting_settings"
  }
}
```

### `POST` atualizar configuracao

Body:

```json
{
  "mode": "add",
  "ignoredTagIds": ["159f7cc7", "194def19"]
}
```

Campos:

- `mode`: opcional. Aceita `replace`, `add` ou `remove`. Default `replace`
- `ignoredTagIds`: obrigatorio. Array de IDs de tags

Exemplo:

```bash
curl -X POST "https://onetapgo.site/api/tags/reporting-settings" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "add",
    "ignoredTagIds": ["159f7cc7", "194def19"]
  }'
```

Observacoes:

- a configuracao e salva em `site_config/reporting_settings`
- `replace` substitui a lista inteira
- `add` adiciona novas IDs sem remover as atuais
- `remove` remove IDs especificas da lista atual
