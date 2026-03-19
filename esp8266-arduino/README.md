# OneTapGo ESP8266 NFC Writer

Guia curto de operacao do firmware MQTT + NFC sob demanda.

## Visao geral

O dispositivo:

- conecta no Wi-Fi configurado;
- conecta no broker MQTT;
- fica em modo `idle` exibindo status no LCD;
- ativa o modulo NFC somente quando recebe um comando MQTT;
- le ou grava tags NFC em NDEF e publica o resultado no MQTT.

Uso principal:

- `write`: grava uma URL como registro NDEF URI (`U`) compativel com iPhone e Android;
- `read`: le a tag, procura dados NDEF e devolve UID + conteudo encontrado.

## Setup rapido

1. Compile e grave o firmware com PlatformIO.
2. Ligue o dispositivo.
3. Se o Wi-Fi ja estiver configurado, ele tentara conectar automaticamente.
4. Se nao estiver conectado, o LCD mostrara o AP de configuracao e a senha.
5. Configure a rede Wi-Fi pelo portal e aguarde a conexao MQTT.

## LCD e fallback de Wi-Fi

Em operacao normal, o LCD mostra informacoes importantes do hardware:

- status do Wi-Fi;
- SSID;
- RSSI/sinal;
- endereco IP;
- status do MQTT;
- status do NFC;
- estado atual do dispositivo.

Se o dispositivo nao conseguir entrar no Wi-Fi, o LCD mostra o AP local de configuracao:

- SSID: `OneTapGo_XXXXXX`
- Senha: `onetapgo123`

O sufixo do SSID varia conforme o dispositivo.

## Topicos MQTT

Todos os topicos ficam sob:

```text
onetapgo/{deviceId}
```

Topicos usados:

- `onetapgo/{deviceId}/command`
  - subscribe do dispositivo
  - recebe comandos da interface web
- `onetapgo/{deviceId}/status`
  - publish do dispositivo
  - status atual do hardware e conectividade
- `onetapgo/{deviceId}/heartbeat`
  - publish do dispositivo
  - pulso periodico para monitoramento
- `onetapgo/{deviceId}/result`
  - publish do dispositivo
  - resultado de leitura, gravacao, timeout ou erro
- `onetapgo/{deviceId}/debug`
  - publish do dispositivo
  - estado de debug e flags de compatibilidade

## Comandos em `/command`

Todos os comandos usam JSON e o campo `type`.

Comandos aceitos:

- `write`
- `read`
- `status`
- `restart`
- `set_debug`
- `set_read_mode`
- `write_tag`  (alias legado de `write`)
- `read_tag`   (alias legado de `read`)

### `write`

Grava uma unica URL como NDEF URI record (`U`).

Campos aceitos:

- `type`: `write`
- `url`: URL obrigatoria, somente `http://` ou `https://`
- `timeoutSec`: timeout opcional para apresentar a tag
- `lock`: opcional, `true` para tentar bloquear a tag apos gravacao
- `requestId`: opcional, usado para correlacao com a interface web

Exemplo:

```json
{
  "type": "write",
  "url": "https://example.com/tag/123",
  "timeoutSec": 30,
  "lock": false,
  "requestId": "req-001"
}
```

Observacoes:

- payloads que nao forem URL `http/https` sao recusados;
- a gravacao usa NDEF URI record, nao texto livre;
- por padrao a tag permanece regravavel;
- `lock: true` e opcional e depende do tipo de cartao suportar bloqueio seguro.

### `read`

Ativa o leitor NFC e espera uma tag pelo tempo informado.

Campos aceitos:

- `type`: `read`
- `timeoutSec`: timeout opcional para apresentar a tag
- `requestId`: opcional, usado para correlacao

Exemplo:

```json
{
  "type": "read",
  "timeoutSec": 20,
  "requestId": "req-002"
}
```

### `status`

Solicita publicacao imediata do estado atual em `/status`.

Exemplo:

```json
{
  "type": "status"
}
```

### `restart`

Solicita reinicio do dispositivo.

Exemplo:

```json
{
  "type": "restart"
}
```

### `set_debug`

Liga ou desliga o modo de debug publicado em `/debug`.

Exemplo:

```json
{
  "type": "set_debug",
  "enabled": true
}
```

### `set_read_mode`

Flag de compatibilidade com integracoes antigas. Nao reativa leitura continua do fluxo novo.

Exemplo:

```json
{
  "type": "set_read_mode",
  "enabled": false
}
```

## O que o dispositivo publica

### `/status`

Estado atual do dispositivo. A interface web pode esperar, em alto nivel:

- `deviceId`, versao, uptime;
- estado do Wi-Fi, SSID, IP, RSSI;
- estado do MQTT;
- estado do NFC;
- job NFC atual, quando existir;
- ultimo erro, quando existir.

Essa publicacao deve ser tratada como snapshot atual do hardware. Normalmente e enviada como retained.

### `/heartbeat`

Pulso periodico para monitoramento.

A interface web pode esperar:

- `deviceId`;
- status resumido de Wi-Fi/MQTT/NFC;
- uptime;
- memoria livre/telemetria basica;
- timestamp.

Use esse topico para detectar se o dispositivo segue online.

### `/result`

Resultado de operacoes NFC.

Tipos esperados em alto nivel:

- `tag_read`
- `write_success`
- `write_error`
- `nfc_timeout`
- `hardware_error`

Campos que a interface web pode esperar, conforme o caso:

- `requestId`;
- `command`;
- `success`;
- `errorCode`;
- `message`;
- `uid` da tag;
- `tagType`, familia e capacidade;
- informacoes NDEF encontradas;
- URL gravada ou lida;
- indicacao de lock solicitado/aplicado.

Em leitura, o payload retorna o UID e tenta sempre extrair dados NDEF.

Em gravacao, o payload informa sucesso ou erro da escrita e da verificacao.

### `/debug`

Topico auxiliar para flags operacionais.

A interface web pode esperar:

- modo debug habilitado/desabilitado;
- flag de compatibilidade `set_read_mode`;
- eventualmente outros sinais de diagnostico do firmware.

## Fluxo operacional esperado

1. A interface web envia `write` ou `read` em `/command`.
2. O dispositivo pausa a atualizacao normal do LCD e ativa o NFC sob demanda.
3. Se uma tag for apresentada dentro do timeout:
   - `read`: le UID + NDEF e publica em `/result`;
   - `write`: grava a URL em NDEF URI e publica em `/result`.
4. Se nenhuma tag for apresentada no prazo, publica `nfc_timeout`.
5. Ao terminar, o dispositivo volta ao dashboard normal no LCD.

## Compatibilidade

Aliases legados suportados:

- `write_tag` -> `write`
- `read_tag` -> `read`

Campos legados fora do fluxo atual, como `tenantId` e `sectorId`, nao fazem parte do contrato novo.
