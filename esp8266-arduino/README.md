# OneTapGo ESP8266 NFC Writer 5.1.0

Firmware para ESP8266 com RC522, OLED SSD1306, MQTT e configuracao de Wi-Fi local/remota.

## Pinout (HW-364A / NodeMCU LoLin V3)

### RC522 (SPI)

| RC522 | ESP8266 GPIO | NodeMCU |
|-------|--------------|---------|
| SCK   | GPIO 14      | D5      |
| MISO  | GPIO 12      | D6      |
| MOSI  | GPIO 13      | D7      |
| SS    | GPIO 4       | D2      |
| RST   | GPIO 5       | D1      |
| 3.3V  | 3.3V         | 3.3V    |
| GND   | GND          | GND     |

### SSD1306 OLED (I2C)

| OLED | ESP8266 GPIO | NodeMCU | Nota                    |
|------|--------------|---------|-------------------------|
| SDA  | GPIO 14      | D5      | Compartilhado com SCK   |
| SCL  | GPIO 12      | D6      | Compartilhado com MISO  |
| VCC  | 3.3V         | 3.3V    |                         |
| GND  | GND          | GND     |                         |

> **Importante:** O OLED compartilha os mesmos pinos GPIO 12 e 14 com o RC522. O firmware gerencia automaticamente a alternância entre SPI e I2C.

### Compatibilidade com outras placas ESP8266

#### Sem OLED (apenas RC522)

| RC522 | GPIO Alternativo | Compatível com      |
|-------|------------------|---------------------|
| SS    | GPIO 15 (D8)     | Wemos D1 Mini, etc. |
| RST   | GPIO 5 (D1)      | Todas as placas     |

#### Com OLED em pinos dedicados

| OLED | GPIO Alternativo | NodeMCU |
|------|------------------|---------|
| SDA  | GPIO 4 (D2)      | D2      |
| SCL  | GPIO 5 (D1)      | D1      |

Neste caso, altere em `src/config/hardware_config.h`:

```cpp
#define OLED_SDA_PIN   4
#define OLED_SCL_PIN   5
#define RC522_SS_PIN   15
```

## Visao geral

O dispositivo:

- conecta no Wi-Fi configurado;
- conecta no broker MQTT;
- mostra uma tela amigavel no OLED enquanto aguarda comandos;
- le ou grava tags NFC sob demanda;
- permite reconfigurar Wi-Fi pelo botao FLASH ou por MQTT.

URL do painel admin:

```text
https://onetapgo.site/admin
```

## Tela e botao FLASH

Tela idle:

- mostra que o dispositivo esta pronto para receber comando;
- mostra uma identificacao curta do `deviceId` usado no admin/MQTT;
- alterna no rodape entre a URL do admin e uma dica curta de uso.

Gestos do botao FLASH (`GPIO0`):

- `1 toque`: inicia leitura NFC local;
- `2 toques`: mostra a tela de acesso ao admin;
- `3 toques`: mostra a tela tecnica e permanece nela;
- `5s pressionado`: abre o portal Wi-Fi.

Observacao:

- `GPIO0` continua sendo pino de boot/programacao; se estiver pressionado ao reiniciar, a placa pode entrar em modo flash.

## LED azul interno

- pisca quando recebe ou publica MQTT;
- fica aceso durante jobs de leitura e gravacao NFC;
- usa o LED onboard do ESP8266 em `GPIO2` com logica `active-low`.

## Wi-Fi local

Se nao houver Wi-Fi valido, o dispositivo abre o AP:

```text
SSID: OneTapGo_XXXXXX
Senha: onetapgo123
```

No portal:

- conecte no AP do dispositivo;
- acesse `192.168.4.1`;
- escolha a nova rede e salve.

## MQTT

Topicos:

```text
onetapgo/{deviceId}/command
onetapgo/{deviceId}/status
onetapgo/{deviceId}/heartbeat
onetapgo/{deviceId}/result
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

Topico legado:

- `onetapgo/{deviceId}/debug`
  - era usado por versoes antigas para flags operacionais
  - no firmware atual `5.1.0` nao ha publish dedicado nesse topico; flags como `set_debug` sao refletidas em `/status`

Comandos suportados em `/command`:

- `write`
- `read`
- `status`
- `restart`
- `set_debug`
- `set_read_mode`
- `wifi_scan`
- `wifi_set`
- `wifi_reset`
- `wifi_portal`
- `write_tag` e `read_tag` como aliases legados

### `write`

```json
{
  "type": "write",
  "url": "https://example.com/tag/123",
  "timeoutSec": 30,
  "lock": false,
  "requestId": "req-001"
}
```

### `read`

```json
{
  "type": "read",
  "timeoutSec": 20,
  "requestId": "req-002"
}
```

### `wifi_scan`

```json
{
  "type": "wifi_scan",
  "requestId": "req-wifi-scan"
}
```

Resultado:

- `wifi_scan_result`
- lista limitada das redes mais fortes com `ssid`, `rssi`, `quality`, `secure`, `channel`

### `wifi_set`

```json
{
  "type": "wifi_set",
  "requestId": "req-wifi-set",
  "ssid": "MeuWiFi",
  "password": "senha123",
  "timeoutSec": 30,
  "portalOnFail": true
}
```

Fluxo:

- publica `wifi_set_ack` antes da troca;
- troca para a nova rede;
- publica `wifi_set_result` quando conseguir reconectar ao broker.

### `wifi_reset`

```json
{
  "type": "wifi_reset",
  "requestId": "req-wifi-reset",
  "startPortal": true
}
```

Resultado:

- `wifi_reset_result`

### `wifi_portal`

```json
{
  "type": "wifi_portal",
  "requestId": "req-wifi-portal",
  "enabled": true,
  "timeoutSec": 180
}
```

Resultado:

- `wifi_portal_result`

## Status e resultados

`/status` inclui:

- `deviceId`
- `version`
- `state`
- `ssid`, `ip`, `rssi`
- `portalActive`, `apActive`
- `wifiReconfigPending`
- `mqttConnected`
- `nfcReady`
- `lastWifiError` e ultimo erro geral, quando existirem

`/result` pode publicar:

- `tag_read`
- `write_success`
- `write_error`
- `nfc_timeout`
- `hardware_error`
- `wifi_scan_result`
- `wifi_set_ack`
- `wifi_set_result`
- `wifi_reset_result`
- `wifi_portal_result`

## Build

```bash
pio run -e nodemcuv2
```

Upload:

```bash
pio run -e nodemcuv2 -t upload
```
