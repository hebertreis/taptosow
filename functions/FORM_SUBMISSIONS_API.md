# Form Submissions API

Base publica:

- `https://onetapgo.site`

Endpoint:

- `GET /api/form-submissions`
- `POST /api/form-submissions`

Objetivo:

- `POST`: salvar formularios enviados pelos sites
- `GET`: permitir que outros sistemas consultem e validem dados de pessoas por tenant

## `GET /api/form-submissions`

Consulta submissões de formularios por tenant.

### Query params

- `tenant`: obrigatorio. Tambem aceita `churchSlug` ou `slug` como alias.
- `formType`: opcional. Filtra o tipo do formulario.
- `name`: opcional. Busca por nome da pessoa.
- `email`: opcional. Busca por email.
- `phone`: opcional. Busca por telefone.
- `document`: opcional. Busca por CPF/CNPJ ou outro documento numerico.
- `q`: opcional. Busca geral por qualquer texto relevante do formulario.
- `limit`: opcional. Quantidade maxima de registros retornados. Default `20`, max `100`.

### Exemplo por tenant

```bash
curl "https://onetapgo.site/api/form-submissions?tenant=iarca"
```

### Exemplo por tenant e email

```bash
curl "https://onetapgo.site/api/form-submissions?tenant=iarca&email=joao@exemplo.com"
```

### Exemplo por tenant e documento

```bash
curl "https://onetapgo.site/api/form-submissions?tenant=iarca&document=12345678901"
```

### Exemplo por tenant e busca geral

```bash
curl "https://onetapgo.site/api/form-submissions?tenant=iarca&q=joao"
```

### Resposta `200`

```json
{
  "success": true,
  "filters": {
    "tenant": "iarca",
    "email": "joao@exemplo.com",
    "limit": 20
  },
  "count": 1,
  "submissions": [
    {
      "id": "submission_123",
      "tenant": "iarca",
      "churchSlug": "iarca",
      "churchName": "IARCA",
      "formType": "membership",
      "formData": {
        "name": "Joao Silva",
        "email": "joao@exemplo.com",
        "phone": "11999999999"
      },
      "destination": "crm",
      "sourcePath": "/iarca",
      "referer": "https://onetapgo.site/iarca",
      "origin": "https://onetapgo.site",
      "createdAt": "2026-03-28T14:00:00.000Z",
      "updatedAt": "2026-03-28T14:00:00.000Z"
    }
  ]
}
```

### Erros

- `400`

```json
{
  "success": false,
  "error": "tenant is required"
}
```

- `500`

```json
{
  "success": false,
  "error": "Internal Server Error"
}
```

### Regras de busca

- a consulta sempre exige `tenant`
- `name` e `q` fazem comparacao textual normalizada
- `email` compara sem diferenciar maiusculas/minusculas
- `phone` e `document` comparam apenas digitos
- os resultados sao ordenados por `createdAt` decrescente

## `POST /api/form-submissions`

Salva uma nova submissao.

### Body

```json
{
  "churchSlug": "iarca",
  "churchName": "IARCA",
  "formType": "membership",
  "formData": {
    "name": "Joao Silva",
    "email": "joao@exemplo.com",
    "phone": "11999999999",
    "document": "12345678901"
  },
  "destination": "crm",
  "sourcePath": "/iarca"
}
```

### Campos obrigatorios

- `churchSlug`
- `formType`
- `formData` como objeto JSON

### Resposta `200`

```json
{
  "success": true,
  "submissionId": "abc123"
}
```

### Observacoes de compatibilidade

- novas submissões passam a gravar campos normalizados para facilitar a consulta
- registros antigos continuam sendo consultaveis por fallback em `churchSlug`
- o endpoint hoje nao exige autenticacao

## Recomendacao para consumo no outro sistema

- sempre enviar `tenant`
- usar `email`, `document` ou `phone` como filtros principais quando houver
- usar `q` apenas como busca complementar
- tratar `count = 0` como nenhum cadastro localizado
